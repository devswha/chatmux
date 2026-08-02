import { randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';

import {
  tmuxPaneIdentityKey,
  type TmuxPaneIdentity,
  type TmuxProcessGeneration,
} from '../../../../shared/tmux.js';
import type { ProviderConnectionIssue } from '../../../../shared/provider-connection.js';

import {
  getExternalCliSessionsDetailedFresh,
  type ExternalCliSession,
  type ExternalCliSessionsDetailedResult,
} from './external-cli-sessions.service.js';
import {
  resolveExternalSessionActivity,
  toExternalSessionDisplayActivity,
  type ExternalSessionDisplayActivity,
} from './external-session-activity.service.js';
import {
  captureHostDiscoveryPanes,
  type HostDiscoveryPane,
  type HostDiscoveryPaneSnapshot,
} from './host-discovery-snapshot.service.js';
import {
  getLiveGjcSessionsDetailed,
  IDLE_GJC_ID_PREFIX,
  type LiveGjcSession,
  type LiveGjcSessionsDetailedResult,
} from './live-sessions.service.js';
import { getCachedTmuxInteractiveActivity } from './tmux-interactive-prompt.service.js';

export const C_SCAN_MS = 1_000;
export const C_SCAN_IDLE_MS = 10_000;
export const FORCE_REFRESH_DEBOUNCE_MS = 250;
export const GRACE_TICKS_LIVE = 2;
export const GRACE_TICKS_EXTERNAL = 2;
export const GJC_BINDING_GRACE_TICKS = 5;
export const UNAVAILABLE_DEGRADE_TICKS = 30;
export const FULL_SCAN_FALLBACK_MS = 30_000;

export type DiscoveryEpoch = string;
export type DiscoveryLane = 'external' | 'live';
export type DiscoveryRowKey = string;

export type DiscoveryRow = Readonly<{
  key: DiscoveryRowKey;
  lane: DiscoveryLane;
  tmuxName: string;
  tmux: TmuxPaneIdentity;
  process: TmuxProcessGeneration | null;
  kind: string;
  providerSessionId: string | null;
  connectionIssue?: ProviderConnectionIssue;
  activity: ExternalSessionDisplayActivity;
  /** Server-authoritative proof that tmux actions may target this live row. */
  tmuxActionable?: boolean;
  cwd: string | null;
  lastSeenRevision: number;
  presence: 'present' | 'stale';
  staleSinceRevision: number | null;
}>;

export type DiscoveryLaneHealth = Readonly<{
  ok: boolean;
  lastOkRevision: number | null;
  consecutiveFailures: number;
}>;

export type DiscoverySnapshot = Readonly<{
  epoch: DiscoveryEpoch;
  revision: number;
  takenAtMs: number;
  rows: readonly DiscoveryRow[];
  health: Readonly<Record<DiscoveryLane, DiscoveryLaneHealth>>;
}>;

export type DiscoveryLiveScanResult = Pick<LiveGjcSessionsDetailedResult, 'ok' | 'sessions'>;

export type DiscoveryDetailedSnapshot = Readonly<{
  takenAtMs: number | null;
  external: ExternalCliSessionsDetailedResult | null;
  live: (DiscoveryLiveScanResult & {
    transcriptPaths?: LiveGjcSessionsDetailedResult['transcriptPaths'];
  }) | null;
}>;

export type DiscoveryCollectorOptions = {
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearTimer?: (timer: ReturnType<typeof setInterval>) => void;
  scanExternal?: () => Promise<ExternalCliSessionsDetailedResult>;
  scanLive?: () => Promise<DiscoveryLiveScanResult>;
  scanHost?: (() => Promise<HostDiscoveryPaneSnapshot>) | null;
  isProcessAlive?: (pid: number) => Promise<boolean>;
};

export type DiscoveryCollector = {
  start(): void;
  stop(): void;
  dispose(): void;
  setActive(active: boolean): void;
  forceRefresh(): void;
  tick(): Promise<void>;
  ensureFresh(maxAgeMs: number, forceFull?: boolean): Promise<void>;
  currentSnapshot(): DiscoverySnapshot;
  currentDetailed(): DiscoveryDetailedSnapshot;
  onSnapshot(listener: (snapshot: DiscoverySnapshot) => void): () => void;
};

type LaneState = {
  failures: number;
  health: DiscoveryLaneHealth;
};

function rowKey(lane: DiscoveryLane, tmux: TmuxPaneIdentity): DiscoveryRowKey {
  return `${lane}\0${tmuxPaneIdentityKey(tmux)}`;
}

function tmuxSessionNameKey(row: Pick<DiscoveryRow, 'tmuxName' | 'tmux'>): string {
  return `${row.tmux.socketPath}\0${row.tmuxName}`;
}

function sameRow(a: DiscoveryRow, b: DiscoveryRow): boolean {
  return a.key === b.key
    && a.lane === b.lane
    && a.tmuxName === b.tmuxName
    && a.tmux.socketPath === b.tmux.socketPath
    && a.tmux.sessionId === b.tmux.sessionId
    && a.tmux.windowId === b.tmux.windowId
    && a.tmux.paneId === b.tmux.paneId
    && a.process?.pid === b.process?.pid
    && a.process?.startedAtMs === b.process?.startedAtMs
    && a.kind === b.kind
    && a.providerSessionId === b.providerSessionId
    && a.connectionIssue === b.connectionIssue
    && a.activity === b.activity
    && a.tmuxActionable === b.tmuxActionable
    && a.cwd === b.cwd
    && a.presence === b.presence
    && a.staleSinceRevision === b.staleSinceRevision;
}

function hostPaneFingerprint(panes: readonly HostDiscoveryPane[]): string {
  return panes
    .map((pane) => [
      tmuxPaneIdentityKey(pane.tmux),
      pane.name,
      pane.pid,
      pane.command,
      pane.cwd ?? '',
      pane.codexThreadId ?? '',
      pane.taggedKind ?? '',
      pane.taggedSessionId ?? '',
    ].join('\0'))
    .sort()
    .join('\n');
}

async function defaultProcessAlive(pid: number): Promise<boolean> {
  return access(`/proc/${pid}`).then(() => true, () => false);
}

function defaultLiveScan(): Promise<DiscoveryLiveScanResult & {
  transcriptPaths: LiveGjcSessionsDetailedResult['transcriptPaths'];
}> {
  return getLiveGjcSessionsDetailed();
}

export function createDiscoveryCollector(options: DiscoveryCollectorOptions = {}): DiscoveryCollector {
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? setInterval;
  const clearTimer = options.clearTimer ?? clearInterval;
  const scanExternal = options.scanExternal ?? getExternalCliSessionsDetailedFresh;
  const scanLive = options.scanLive ?? defaultLiveScan;
  const scanHost = options.scanHost === undefined
    ? options.scanExternal === undefined && options.scanLive === undefined
      ? captureHostDiscoveryPanes
      : null
    : options.scanHost;
  const isProcessAlive = options.isProcessAlive ?? defaultProcessAlive;
  const epoch = randomUUID();
  let revision = 0;
  let rows = new Map<DiscoveryRowKey, DiscoveryRow>();
  const missingTicks = new Map<DiscoveryRowKey, number>();
  const liveBindingMissingTicks = new Map<DiscoveryRowKey, number>();
  const laneState: Record<DiscoveryLane, LaneState> = {
    external: { failures: 0, health: { ok: true, lastOkRevision: null, consecutiveFailures: 0 } },
    live: { failures: 0, health: { ok: true, lastOkRevision: null, consecutiveFailures: 0 } },
  };
  let timer: ReturnType<typeof setInterval> | null = null;
  let forceTimer: ReturnType<typeof setInterval> | null = null;
  let active = false;
  let currentTick: Promise<void> | null = null;
  let currentTickSatisfiesFullScan = false;
  let fullRefreshPending = false;
  let requireFullScan = false;
  let lastFullScanAtMs: number | null = null;
  let lastHostFingerprint: string | null = null;
  let disposed = false;
  const listeners = new Set<(next: DiscoverySnapshot) => void>();
  let snapshot = makeSnapshot(now());
  let detailed: DiscoveryDetailedSnapshot = Object.freeze({
    takenAtMs: null,
    external: null,
    live: null,
  });

  function freezeRow(row: DiscoveryRow): DiscoveryRow {
    const tmux = Object.freeze({ ...row.tmux });
    const process = row.process === null ? null : Object.freeze({ ...row.process });
    return Object.freeze({ ...row, tmux, process });
  }

  function makeSnapshot(takenAtMs: number): DiscoverySnapshot {
    const health = Object.freeze({
      external: Object.freeze({ ...laneState.external.health }),
      live: Object.freeze({ ...laneState.live.health }),
    });
    return Object.freeze({
      epoch,
      revision,
      takenAtMs,
      rows: Object.freeze([...rows.values()].sort((a, b) => a.key.localeCompare(b.key)).map(freezeRow)),
      health,
    });
  }

  async function externalRows(sessions: readonly ExternalCliSession[]): Promise<DiscoveryRow[]> {
    return Promise.all(sessions.map(async (session) => {
      const process = session.agentPid === undefined || session.startedAtMs === undefined
        ? null
        : { pid: session.agentPid, startedAtMs: session.startedAtMs };
      const transcriptActivity = toExternalSessionDisplayActivity(
        await resolveExternalSessionActivity(session),
      );
      return {
        key: rowKey('external', session.tmux),
        lane: 'external' as const,
        tmuxName: session.tmuxName,
        tmux: session.tmux,
        process,
        kind: session.kind,
        providerSessionId: session.providerSessionId ?? null,
        ...(session.connectionIssue ? { connectionIssue: session.connectionIssue } : {}),
        activity: process
          ? getCachedTmuxInteractiveActivity({ tmux: session.tmux, process }) ?? transcriptActivity
          : transcriptActivity,
        cwd: session.cwd ?? null,
        lastSeenRevision: revision,
        presence: 'present' as const,
        staleSinceRevision: null,
      };
    }));
  }

  function liveRows(sessions: readonly LiveGjcSession[]): DiscoveryRow[] {
    return sessions.flatMap((session): DiscoveryRow[] => {
      if (!session.tmux || !session.tmuxName) return [];
      return [{
        key: rowKey('live', session.tmux),
        lane: 'live',
        tmuxName: session.tmuxName,
        tmux: session.tmux,
        process: session.process,
        kind: 'gjc',
        providerSessionId: session.id,
        ...(session.connectionIssue ? { connectionIssue: session.connectionIssue } : {}),
        activity: session.error === true
          ? 'error'
          : session.process
            ? getCachedTmuxInteractiveActivity({ tmux: session.tmux, process: session.process })
              ?? (session.running === true ? 'running' : 'unknown')
            : session.running === true
              ? 'running'
              : 'unknown',
        tmuxActionable: !session.connectionIssue
          && session.claim === 'lineage'
          && session.process !== null,
        cwd: null,
        lastSeenRevision: revision,
        presence: 'present',
        staleSinceRevision: null,
      }];
    });
  }

  function applyAvailable(lane: DiscoveryLane, scannedRows: readonly DiscoveryRow[]): boolean {
    const next = new Map(rows);
    const found = new Map(scannedRows.map((row) => [row.key, row]));
    const observedSessionIds = new Map(
      scannedRows.map((row) => [tmuxSessionNameKey(row), row.tmux.sessionId]),
    );
    let changed = false;
    const grace = lane === 'live' ? GRACE_TICKS_LIVE : GRACE_TICKS_EXTERNAL;

    for (const [key, previous] of rows) {
      if (previous.lane !== lane) continue;
      const observed = found.get(key);
      if (observed) {
        const sameProcessGeneration = previous.process !== null
          && observed.process !== null
          && previous.process.pid === observed.process.pid
          && previous.process.startedAtMs === observed.process.startedAtMs;
        const temporarilyUnboundLiveGjc = lane === 'live'
          && sameProcessGeneration
          && previous.providerSessionId !== null
          && !previous.providerSessionId.startsWith(IDLE_GJC_ID_PREFIX)
          && observed.providerSessionId?.startsWith(IDLE_GJC_ID_PREFIX) === true;
        let candidate: DiscoveryRow;
        if (temporarilyUnboundLiveGjc) {
          const misses = (liveBindingMissingTicks.get(key) ?? 0) + 1;
          liveBindingMissingTicks.set(key, misses);
          candidate = misses < GJC_BINDING_GRACE_TICKS
            ? {
                ...previous,
                lastSeenRevision: revision + 1,
                presence: 'present',
                staleSinceRevision: null,
              }
            : { ...observed, lastSeenRevision: revision + 1 };
          if (misses >= GJC_BINDING_GRACE_TICKS) liveBindingMissingTicks.delete(key);
        } else {
          liveBindingMissingTicks.delete(key);
          candidate = { ...observed, lastSeenRevision: revision + 1 };
        }
        const replacement = sameRow(previous, candidate) ? previous : candidate;
        if (replacement !== previous) {
          next.set(key, replacement);
          changed = true;
        }
        found.delete(key);
        missingTicks.delete(key);
        continue;
      }
      const replacementSessionId = observedSessionIds.get(tmuxSessionNameKey(previous));
      if (replacementSessionId !== undefined && replacementSessionId !== previous.tmux.sessionId) {
        missingTicks.delete(key);
        liveBindingMissingTicks.delete(key);
        next.delete(key);
        changed = true;
        continue;
      }
      if (previous.presence === 'present') {
        missingTicks.set(key, 1);
        next.set(key, { ...previous, presence: 'stale', staleSinceRevision: revision + 1 });
        changed = true;
      } else {
        const misses = (missingTicks.get(key) ?? 1) + 1;
        missingTicks.set(key, misses);
        if (misses >= grace) {
          missingTicks.delete(key);
          liveBindingMissingTicks.delete(key);
          next.delete(key);
          changed = true;
        }
      }
    }
    for (const [key, row] of found) {
      liveBindingMissingTicks.delete(key);
      next.set(key, { ...row, lastSeenRevision: revision + 1 });
      changed = true;
    }
    if (changed) rows = next;
    return changed;
  }

  function applyUnavailable(lane: DiscoveryLane): boolean {
    const state = laneState[lane];
    state.failures += 1;
    if (state.failures !== UNAVAILABLE_DEGRADE_TICKS || !state.health.ok) return false;
    state.health = { ...state.health, ok: false, consecutiveFailures: state.failures };
    return true;
  }

  function applyKnownSuccess(lane: DiscoveryLane): boolean {
    const state = laneState[lane];
    const changed = !state.health.ok || state.health.lastOkRevision === null || state.health.consecutiveFailures !== 0;
    state.failures = 0;
    if (changed) state.health = { ok: true, lastOkRevision: revision + 1, consecutiveFailures: 0 };
    return changed;
  }

  async function trackedProcessesAreAlive(): Promise<boolean> {
    const pids = [...new Set(
      [...rows.values()]
        .map((row) => row.process?.pid)
        .filter((pid): pid is number => pid !== undefined),
    )];
    if (pids.length === 0) return true;
    return (await Promise.all(pids.map((pid) => isProcessAlive(pid)))).every(Boolean);
  }

  function runTick(forceFull: boolean): Promise<void> {
    if (disposed) return Promise.resolve();
    if (currentTick) {
      if (forceFull && !currentTickSatisfiesFullScan) {
        fullRefreshPending = true;
        return currentTick.then(() => runTick(true));
      }
      return currentTick;
    }
    currentTickSatisfiesFullScan = forceFull
      || requireFullScan
      || scanHost === null
      || detailed.takenAtMs === null
      || lastFullScanAtMs === null
      || now() - lastFullScanAtMs >= FULL_SCAN_FALLBACK_MS
      || [...rows.values()].some((row) => row.presence === 'stale');
    const running = (async () => {
      let probeFingerprint: string | null = null;
      let runFullScan = currentTickSatisfiesFullScan;

      if (!runFullScan && scanHost) {
        const probe = await scanHost().catch((): HostDiscoveryPaneSnapshot => ({
          ok: false,
          capturedAtMs: now(),
          panes: [],
        }));
        if (disposed) return;
        if (!probe.ok) {
          runFullScan = true;
        } else {
          probeFingerprint = hostPaneFingerprint(probe.panes);
          runFullScan = probeFingerprint !== lastHostFingerprint
            || !await trackedProcessesAreAlive();
          currentTickSatisfiesFullScan = runFullScan;
          if (!runFullScan) {
            const takenAtMs = now();
            detailed = Object.freeze({ ...detailed, takenAtMs });
            snapshot = makeSnapshot(takenAtMs);
            // Same revision, but listeners must still see the tick: the
            // discovery stream derives its heartbeat cadence from unchanged
            // snapshots, and a silent skip path starves subscribed clients
            // into declaring the stream stale and resuming REST polling.
            for (const listener of listeners) listener(snapshot);
            return;
          }
        }
      }

      const [external, live] = await Promise.all([
        scanExternal().catch(() => ({ ok: false, sessions: [] })),
        scanLive().catch(() => ({ ok: false, sessions: [] })),
      ]);
      if (disposed) return;
      const takenAtMs = now();
      detailed = Object.freeze({ takenAtMs, external, live });
      let changed = false;
      if (external.ok) {
        changed = applyKnownSuccess('external') || changed;
        changed = applyAvailable('external', await externalRows(external.sessions)) || changed;
      } else {
        changed = applyUnavailable('external') || changed;
      }
      if (live.ok) {
        changed = applyKnownSuccess('live') || changed;
        changed = applyAvailable('live', liveRows(live.sessions)) || changed;
      } else {
        changed = applyUnavailable('live') || changed;
      }
      if (changed) revision += 1;
      snapshot = makeSnapshot(takenAtMs);
      for (const listener of listeners) listener(snapshot);
      requireFullScan = !external.ok || !live.ok;
      if (!requireFullScan) {
        lastFullScanAtMs = takenAtMs;
        if (probeFingerprint !== null) lastHostFingerprint = probeFingerprint;
      }
    })().finally(() => {
      if (currentTick === running) {
        currentTick = null;
        currentTickSatisfiesFullScan = false;
      }
      if (fullRefreshPending && !disposed) {
        fullRefreshPending = false;
        void runTick(true);
      }
    });
    currentTick = running;
    return running;
  }

  function schedule(): void {
    if (timer) clearTimer(timer);
    timer = setTimer(() => { void runTick(false); }, active ? C_SCAN_MS : C_SCAN_IDLE_MS);
  }

  return {
    start() {
      if (disposed || timer) return;
      schedule();
    },
    stop() {
      if (timer) clearTimer(timer);
      if (forceTimer) clearTimer(forceTimer);
      timer = null;
      forceTimer = null;
    },
    dispose() {
      disposed = true;
      this.stop();
      listeners.clear();
    },
    setActive(nextActive) {
      if (disposed || active === nextActive) return;
      active = nextActive;
      if (timer) schedule();
    },
    forceRefresh() {
      if (disposed || forceTimer) return;
      forceTimer = setTimer(() => {
        if (forceTimer) clearTimer(forceTimer);
        forceTimer = null;
        void runTick(true);
      }, FORCE_REFRESH_DEBOUNCE_MS);
    },
    tick: () => runTick(true),
    async ensureFresh(maxAgeMs, forceFull = false) {
      const ageMs = detailed.takenAtMs === null
        ? Number.POSITIVE_INFINITY
        : Math.max(0, now() - detailed.takenAtMs);
      if (!forceFull && ageMs <= Math.max(0, maxAgeMs)) return;
      await runTick(forceFull);
    },
    currentSnapshot: () => snapshot,
    currentDetailed: () => detailed,
    onSnapshot(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
