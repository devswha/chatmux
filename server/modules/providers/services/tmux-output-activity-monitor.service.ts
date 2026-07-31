import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';

import {
  paneSubscriptionKey,
  type TmuxPaneIdentity,
} from '../../../../shared/tmux.js';

import { runTmux, type TmuxRunner } from './builtin-relay.service.js';
import {
  type DiscoveryCollector,
  type DiscoveryRow,
  type DiscoverySnapshot,
} from './discovery-collector.service.js';
import type { ExternalLocalCliKind } from './external-cli-sessions.service.js';
import {
  setObservedTmuxInteractiveActivity,
  tmuxScreenHasInteractivePrompt,
} from './tmux-interactive-prompt.service.js';
import {
  onTranscriptChanged,
  type TranscriptChange,
} from './transcript-change.service.js';

export const TMUX_OUTPUT_QUIET_MS = 250;
export const TMUX_OUTPUT_MAX_WAIT_MS = 2_000;
export const TMUX_OUTPUT_CLEAR_CONFIRM_MS = 350;
export const TMUX_OUTPUT_FALLBACK_MS = 30_000;
export const TMUX_OUTPUT_RECONNECT_MAX_MS = 30_000;

type SupportedKind = Extract<ExternalLocalCliKind, 'claude' | 'codex' | 'omp'> | 'gjc';
type SessionIdentity = Pick<TmuxPaneIdentity, 'socketPath' | 'sessionId'>;
type Timer = ReturnType<typeof setTimeout>;

export type TmuxOutputActivityTarget = Readonly<{
  tmux: Readonly<TmuxPaneIdentity>;
  process: Readonly<NonNullable<DiscoveryRow['process']>>;
  kind: SupportedKind;
  tmuxName: string;
  providerSessionId: string | null;
}>;

export type TmuxControlObserver = {
  close(): void;
};

export type TmuxControlObserverFactory = (
  session: SessionIdentity,
  onPaneOutput: (paneId: string) => void,
  onExit: (reason: string) => void,
) => TmuxControlObserver;

export type TmuxOutputActivityMonitorOptions = {
  quietMs?: number;
  maxWaitMs?: number;
  clearConfirmMs?: number;
  fallbackMs?: number;
  reconnectMaxMs?: number;
  runTmux?: TmuxRunner;
  capture?: (target: TmuxOutputActivityTarget) => Promise<string>;
  observerFactory?: TmuxControlObserverFactory;
  canObserveSession?: (session: SessionIdentity) => Promise<boolean>;
  subscribeTranscript?: (listener: (change: TranscriptChange) => void) => () => void;
  warn?: (message: string) => void;
};

type PaneState = {
  key: string;
  row: DiscoveryRow & { process: NonNullable<DiscoveryRow['process']> };
  target: TmuxOutputActivityTarget;
  screenHash: string | null;
  observedPrompt: boolean;
  clearMisses: number;
  quietTimer: Timer | null;
  maxTimer: Timer | null;
  inFlight: boolean;
  pending: boolean;
  forceParse: boolean;
  disposed: boolean;
};

type SessionState = {
  key: string;
  identity: SessionIdentity;
  observer: TmuxControlObserver | null;
  starting: boolean;
  disabled: boolean;
  reconnectTimer: Timer | null;
  reconnectDelayMs: number;
};

const SUPPORTED_KINDS = new Set<SupportedKind>(['gjc', 'codex', 'omp', 'claude']);
const CONTROL_OUTPUT_RE = /^%(?:extended-)?output\s+(%\d+)(?:\s|$)/;
const CONTROL_BUFFER_MAX = 1024 * 1024;

function sessionKey(identity: SessionIdentity): string {
  return `${identity.socketPath}\0${identity.sessionId}`;
}

function isSupportedRow(
  row: DiscoveryRow,
): row is DiscoveryRow & {
  process: NonNullable<DiscoveryRow['process']>;
  kind: SupportedKind;
} {
  return row.presence === 'present'
    && row.process !== null
    && !row.connectionIssue
    && SUPPORTED_KINDS.has(row.kind as SupportedKind);
}

function targetFor(
  row: DiscoveryRow & {
    process: NonNullable<DiscoveryRow['process']>;
    kind: SupportedKind;
  },
): TmuxOutputActivityTarget {
  return Object.freeze({
    tmux: Object.freeze({ ...row.tmux }),
    process: Object.freeze({ ...row.process }),
    kind: row.kind,
    tmuxName: row.tmuxName,
    providerSessionId: row.providerSessionId,
  });
}

export function tmuxControlOutputPaneId(line: string): string | null {
  return CONTROL_OUTPUT_RE.exec(line)?.[1] ?? null;
}

export function createTmuxControlObserver(
  session: SessionIdentity,
  onPaneOutput: (paneId: string) => void,
  onExit: (reason: string) => void,
): TmuxControlObserver {
  const child: ChildProcessWithoutNullStreams = spawn('tmux', [
    '-C',
    '-S', session.socketPath,
    'attach-session',
    '-r',
    '-f', 'active-pane',
    '-t', session.sessionId,
  ], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  let stderr = '';
  let closing = false;
  let exited = false;

  const finish = (reason: string): void => {
    if (exited) return;
    exited = true;
    onExit(reason);
  };
  const consume = (chunk: Buffer): void => {
    buffer += decoder.write(chunk);
    if (buffer.length > CONTROL_BUFFER_MAX) buffer = buffer.slice(-CONTROL_BUFFER_MAX);
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);
      const paneId = tmuxControlOutputPaneId(line);
      if (paneId) onPaneOutput(paneId);
      newline = buffer.indexOf('\n');
    }
  };

  child.stdout.on('data', consume);
  child.stderr.on('data', (chunk: Buffer) => {
    if (stderr.length < 2_000) stderr += chunk.toString('utf8');
  });
  child.stdin.on('error', () => undefined);
  child.on('error', (error) => finish(error.message));
  child.on('close', (code, signal) => {
    finish(closing
      ? 'closed'
      : stderr.trim() || `tmux control observer exited (${code ?? signal ?? 'unknown'})`);
  });

  return {
    close() {
      if (closing) return;
      closing = true;
      if (!child.killed && child.stdin.writable) child.stdin.end('detach-client\n');
      const killTimer = setTimeout(() => {
        if (!child.killed) child.kill('SIGTERM');
      }, 500);
      killTimer.unref?.();
    },
  };
}

/**
 * destroy-unattached is a session option: a session-local override survives a
 * global "off", and any non-off mode (on/keep-last/keep-group) can destroy the
 * observed session the moment this read-only client detaches. Read failures
 * are treated as unsafe — attaching on unknown settings risks killing the
 * user's live agent session.
 */
export async function tmuxObserverIsSafe(
  session: SessionIdentity,
  run: TmuxRunner,
): Promise<boolean> {
  const [globalDestroy, sessionDestroy, exitUnattached] = await Promise.all([
    run(['-S', session.socketPath, 'show-options', '-gv', 'destroy-unattached']),
    run(['-S', session.socketPath, 'show-options', '-t', session.sessionId, '-qv', 'destroy-unattached']),
    run(['-S', session.socketPath, 'show-options', '-gv', 'exit-unattached']),
  ]);
  if (globalDestroy.code !== 0 || sessionDestroy.code !== 0 || exitUnattached.code !== 0) {
    return false;
  }
  const globalValue = globalDestroy.output.trim();
  const sessionValue = sessionDestroy.output.trim();
  return (globalValue === '' || globalValue === 'off')
    && (sessionValue === '' || sessionValue === 'off')
    && exitUnattached.output.trim() !== 'on';
}

async function captureObservedPane(
  target: TmuxOutputActivityTarget,
  run: TmuxRunner,
): Promise<string> {
  const result = await run([
    '-S', target.tmux.socketPath,
    'capture-pane', '-p', '-e', '-N', '-S', '-80', '-t', target.tmux.paneId,
  ]);
  if (result.code !== 0) throw new Error('tmux pane capture failed');
  return result.output;
}

/**
 * Converts tmux control-mode output into pane-local interactive state updates.
 * Control clients are read-only and ignore-size; transcript events and a slow
 * fallback preserve correctness while observers reconnect or are unsafe.
 */
export function createTmuxOutputActivityMonitor(
  collector: Pick<DiscoveryCollector, 'currentSnapshot' | 'forceRefresh' | 'onSnapshot'>,
  options: TmuxOutputActivityMonitorOptions = {},
) {
  const quietMs = options.quietMs ?? TMUX_OUTPUT_QUIET_MS;
  const maxWaitMs = options.maxWaitMs ?? TMUX_OUTPUT_MAX_WAIT_MS;
  const clearConfirmMs = options.clearConfirmMs ?? TMUX_OUTPUT_CLEAR_CONFIRM_MS;
  const fallbackMs = options.fallbackMs ?? TMUX_OUTPUT_FALLBACK_MS;
  const reconnectMaxMs = options.reconnectMaxMs ?? TMUX_OUTPUT_RECONNECT_MAX_MS;
  const run = options.runTmux ?? runTmux;
  const capture = options.capture ?? ((target) => captureObservedPane(target, run));
  const observerFactory = options.observerFactory ?? createTmuxControlObserver;
  const canObserve = options.canObserveSession
    ?? ((session: SessionIdentity) => tmuxObserverIsSafe(session, run));
  const subscribeTranscript = options.subscribeTranscript ?? onTranscriptChanged;
  const warn = options.warn ?? ((message: string) => console.warn(`[tmux-input] ${message}`));
  const panes = new Map<string, PaneState>();
  const sessions = new Map<string, SessionState>();
  let started = false;
  let disposed = false;
  let unsubscribeSnapshot: (() => void) | null = null;
  let unsubscribeTranscript: (() => void) | null = null;
  let fallbackTimer: ReturnType<typeof setInterval> | null = null;

  const clearPaneTimers = (pane: PaneState): void => {
    if (pane.quietTimer) clearTimeout(pane.quietTimer);
    if (pane.maxTimer) clearTimeout(pane.maxTimer);
    pane.quietTimer = null;
    pane.maxTimer = null;
  };

  const publishPrompt = (pane: PaneState, active: boolean, syncObservers = true): void => {
    const activityChanged = pane.observedPrompt !== active;
    pane.observedPrompt = active;
    if (setObservedTmuxInteractiveActivity(pane.target, active)) {
      collector.forceRefresh();
    }
    if (activityChanged && syncObservers) reconcileSessionObservers();
  };

  const inspect = async (pane: PaneState): Promise<void> => {
    if (pane.disposed || disposed) return;
    if (pane.inFlight) {
      pane.pending = true;
      return;
    }
    pane.inFlight = true;
    const parseSameScreen = pane.forceParse;
    pane.forceParse = false;
    try {
      const screen = await capture(pane.target);
      if (pane.disposed || disposed) return;
      const hash = createHash('sha256').update(screen).digest('hex');
      if (!parseSameScreen && pane.screenHash === hash) return;
      pane.screenHash = hash;
      const promptActive = tmuxScreenHasInteractivePrompt(pane.target, screen);
      if (promptActive) {
        pane.clearMisses = 0;
        publishPrompt(pane, true);
      } else if (pane.observedPrompt && pane.clearMisses === 0) {
        pane.clearMisses = 1;
        pane.forceParse = true;
        pane.quietTimer = setTimeout(() => {
          pane.quietTimer = null;
          void inspect(pane);
        }, clearConfirmMs);
        pane.quietTimer.unref?.();
      } else {
        pane.clearMisses = 0;
        publishPrompt(pane, false);
      }
    } catch {
      // Discovery and the fallback loop will retry. Never clear a known INPUT
      // state merely because one pane capture failed — but keep the forced
      // reparse pending, or an unchanged screen hash would suppress the
      // outstanding clear-confirmation forever.
      pane.forceParse = parseSameScreen || pane.forceParse;
    } finally {
      pane.inFlight = false;
      if (pane.pending && !pane.disposed && !disposed) {
        pane.pending = false;
        void inspect(pane);
      }
    }
  };

  const flushPane = (pane: PaneState): void => {
    if (pane.disposed || disposed) return;
    clearPaneTimers(pane);
    void inspect(pane);
  };

  const markPaneDirty = (pane: PaneState, immediate = false): void => {
    if (pane.disposed || disposed) return;
    if (immediate) {
      pane.forceParse = true;
      flushPane(pane);
      return;
    }
    if (pane.quietTimer) clearTimeout(pane.quietTimer);
    pane.quietTimer = setTimeout(() => {
      pane.quietTimer = null;
      flushPane(pane);
    }, quietMs);
    pane.quietTimer.unref?.();
    if (!pane.maxTimer) {
      pane.maxTimer = setTimeout(() => {
        pane.maxTimer = null;
        flushPane(pane);
      }, maxWaitMs);
      pane.maxTimer.unref?.();
    }
  };

  const panesForSession = (identity: SessionIdentity, paneId?: string): PaneState[] => (
    [...panes.values()].filter((pane) => (
      pane.row.tmux.socketPath === identity.socketPath
      && pane.row.tmux.sessionId === identity.sessionId
      && (paneId === undefined || pane.row.tmux.paneId === paneId)
    ))
  );

  const scheduleReconnect = (state: SessionState, reason: string): void => {
    if (disposed || state.disabled || sessions.get(state.key) !== state) return;
    state.observer = null;
    if (state.reconnectTimer) return;
    const delay = state.reconnectDelayMs;
    state.reconnectDelayMs = Math.min(reconnectMaxMs, Math.max(500, delay * 2));
    if (delay >= reconnectMaxMs) warn(`${state.identity.sessionId} observer reconnecting: ${reason}`);
    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = null;
      void ensureObserver(state);
    }, delay);
    state.reconnectTimer.unref?.();
  };

  const ensureObserver = async (state: SessionState): Promise<void> => {
    if (
      disposed
      || state.disabled
      || state.starting
      || state.observer
      || sessions.get(state.key) !== state
    ) return;
    state.starting = true;
    try {
      if (!await canObserve(state.identity)) {
        state.disabled = true;
        warn(`${state.identity.sessionId} uses destroy/exit-unattached; using fallback input detection.`);
        return;
      }
      if (disposed || sessions.get(state.key) !== state) return;
      state.observer = observerFactory(
        state.identity,
        (paneId) => {
          for (const pane of panesForSession(state.identity, paneId)) markPaneDirty(pane);
        },
        (reason) => {
          if (state.observer) state.observer = null;
          scheduleReconnect(state, reason);
        },
      );
      state.reconnectDelayMs = 500;
    } catch (error) {
      scheduleReconnect(state, error instanceof Error ? error.message : String(error));
    } finally {
      state.starting = false;
    }
  };

  const stopSession = (state: SessionState): void => {
    if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
    const observer = state.observer;
    state.observer = null;
    observer?.close();
  };

  function paneNeedsObserver(pane: PaneState): boolean {
    return !pane.observedPrompt
      && (
        pane.row.activity === 'unknown'
        || pane.row.providerSessionId === null
      );
  }

  function reconcileSessionObservers(): void {
    if (disposed) return;
    const desiredSessions = new Map<string, SessionIdentity>();
    for (const pane of panes.values()) {
      if (!paneNeedsObserver(pane)) continue;
      const identity = {
        socketPath: pane.row.tmux.socketPath,
        sessionId: pane.row.tmux.sessionId,
      };
      desiredSessions.set(sessionKey(identity), identity);
    }
    for (const state of [...sessions.values()]) {
      if (!desiredSessions.has(state.key)) {
        sessions.delete(state.key);
        stopSession(state);
      }
    }
    for (const [key, identity] of desiredSessions) {
      let state = sessions.get(key);
      if (!state) {
        state = {
          key,
          identity,
          observer: null,
          starting: false,
          disabled: false,
          reconnectTimer: null,
          reconnectDelayMs: 500,
        };
        sessions.set(key, state);
      }
      void ensureObserver(state);
    }
  }

  const removePane = (pane: PaneState): void => {
    pane.disposed = true;
    clearPaneTimers(pane);
    publishPrompt(pane, false, false);
    panes.delete(pane.key);
  };

  const reconcile = (snapshot: DiscoverySnapshot): void => {
    if (disposed) return;
    const desiredPaneKeys = new Set<string>();
    for (const row of snapshot.rows) {
      if (!isSupportedRow(row)) continue;
      const key = paneSubscriptionKey(row.lane, row.tmux, row.process);
      desiredPaneKeys.add(key);
      const existing = panes.get(key);
      if (existing) {
        const kindChanged = existing.row.kind !== row.kind;
        const bindingChanged = existing.row.providerSessionId !== row.providerSessionId;
        existing.row = row;
        existing.target = targetFor(row);
        if (kindChanged || bindingChanged) {
          existing.screenHash = null;
          existing.clearMisses = 0;
          publishPrompt(existing, false, false);
          markPaneDirty(existing, true);
        }
        continue;
      }
      const pane: PaneState = {
        key,
        row,
        target: targetFor(row),
        screenHash: null,
        observedPrompt: false,
        clearMisses: 0,
        quietTimer: null,
        maxTimer: null,
        inFlight: false,
        pending: false,
        forceParse: true,
        disposed: false,
      };
      panes.set(key, pane);
      markPaneDirty(pane, true);
    }
    for (const pane of [...panes.values()]) {
      if (!desiredPaneKeys.has(pane.key)) removePane(pane);
    }
    reconcileSessionObservers();
  };

  const handleTranscriptChange = (change: TranscriptChange): void => {
    for (const pane of panes.values()) {
      if (pane.row.kind !== change.provider) continue;
      if (
        change.providerSessionId
        && pane.row.providerSessionId !== change.providerSessionId
      ) continue;
      markPaneDirty(pane);
    }
  };

  return {
    start() {
      if (started || disposed) return;
      started = true;
      unsubscribeSnapshot = collector.onSnapshot(reconcile);
      unsubscribeTranscript = subscribeTranscript(handleTranscriptChange);
      reconcile(collector.currentSnapshot());
      fallbackTimer = setInterval(() => {
        for (const pane of panes.values()) void inspect(pane);
      }, fallbackMs);
      fallbackTimer.unref?.();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribeSnapshot?.();
      unsubscribeTranscript?.();
      unsubscribeSnapshot = null;
      unsubscribeTranscript = null;
      if (fallbackTimer) clearInterval(fallbackTimer);
      fallbackTimer = null;
      for (const pane of [...panes.values()]) removePane(pane);
      for (const state of sessions.values()) stopSession(state);
      sessions.clear();
    },
    paneCount: () => panes.size,
    observerCount: () => [...sessions.values()].filter((state) => state.observer !== null).length,
  };
}
