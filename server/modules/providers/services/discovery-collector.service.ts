import { randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';

import {
  publicTerminalKey,
  sourceLaneKey,
  type DiscoveryV2,
  type LaneCoverage,
  type PublicTerminalTarget,
  type RuntimeCapabilities,
  type SourceDescriptor,
  type SourceLaneState,
} from '../../../../shared/terminal-runtime.js';
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
export const HERDR_UNAVAILABLE_GRACE_TICKS_EXTERNAL = 2;
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
  /** Versioned runtime projection. Legacy rows remain tmux-only. */
  v2?: DiscoveryV2;
}>;

export type DiscoveryLiveScanResult = Pick<LiveGjcSessionsDetailedResult, 'ok' | 'sessions'>;
export type DiscoveryRuntimeOutcome = Readonly<{
  runtime: 'tmux' | 'herdr';
  sourceId: string;
  ok: boolean;
  terminals: readonly PublicTerminalTarget[];
}>;
export type DiscoveryRuntimeRegistry = {
  sources(): Promise<SourceDescriptor[]>;
  discoverOutcomes(): Promise<DiscoveryRuntimeOutcome[]>;
  scanDiscovery?(): Promise<{ sources: readonly SourceDescriptor[]; outcomes: readonly DiscoveryRuntimeOutcome[] }>;
  capabilities(runtime: 'tmux' | 'herdr', sourceId: string): RuntimeCapabilities;
};

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
  runtimeRegistry?: DiscoveryRuntimeRegistry;
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
  sourceLaneRevision: number;
};
type RuntimeLaneState = LaneState & { disabled: boolean };
type RuntimeRow = {
  lane: 'external';
  sourceId: string;
  terminal: PublicTerminalTarget;
  lastSeenRevision: number;
  presence: 'present' | 'stale';
  staleSinceRevision: number | null;
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
  const runtimeRegistry = options.runtimeRegistry;
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
    external: { failures: 0, health: { ok: true, lastOkRevision: null, consecutiveFailures: 0 }, sourceLaneRevision: 0 },
    live: { failures: 0, health: { ok: true, lastOkRevision: null, consecutiveFailures: 0 }, sourceLaneRevision: 0 },
  };
  const runtimeRows = new Map<string, RuntimeRow>();
  const runtimeMissingTicks = new Map<string, number>();
  const sourceStates = new Map<string, RuntimeLaneState>();
  let runtimeDescriptors: SourceDescriptor[] = [];
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

  function runtimeState(sourceId: string): RuntimeLaneState {
    const key = sourceLaneKey('external', sourceId);
    let state = sourceStates.get(key);
    if (!state) {
      state = { failures: 0, health: { ok: true, lastOkRevision: null, consecutiveFailures: 0 }, sourceLaneRevision: 0, disabled: false };
      sourceStates.set(key, state);
    }
    return state;
  }

  function runtimeProjection(): DiscoveryV2 | undefined {
    if (!runtimeRegistry) return undefined;
    const tmuxTerminals = [...rows.values()].flatMap((row) => row.process
      ? [{ lane: row.lane, terminal: { runtime: 'tmux' as const, tmux: row.tmux, process: row.process, targetClass: 'local-agent' as const } }]
      : []);
    const terminals = [...tmuxTerminals, ...[...runtimeRows.values()].map((row) => ({ lane: 'external' as const, terminal: row.terminal }))]
      .sort((a, b) => publicTerminalKey(a.lane, a.terminal).localeCompare(publicTerminalKey(b.lane, b.terminal)));
    const runtimeSources = runtimeDescriptors
      .filter((source) => source.runtime === 'herdr')
      .map((source) => {
        const state = runtimeState(source.sourceId);
        const coverage = state.disabled ? 'none' as const : state.failures === 0 ? 'authoritative' as const : state.failures < HERDR_UNAVAILABLE_GRACE_TICKS_EXTERNAL ? 'retained' as const : 'none' as const;
        return { lane: 'external' as const, sourceId: source.sourceId, runtime: 'herdr' as const, readiness: source.readiness, capabilities: coverage === 'authoritative' ? runtimeRegistry.capabilities('herdr', source.sourceId) : { discovery: false, output: false, actions: false, attach: false, create: false }, sourceLaneRevision: state.sourceLaneRevision, lastOkGlobalRevision: state.health.lastOkRevision ?? 0, coverage, consecutiveFailures: state.health.consecutiveFailures };
      });
    const sourceLanes: SourceLaneState[] = [
      ...(['external', 'live'] as const).map((lane) => ({ lane, sourceId: 'tmux.local', runtime: 'tmux' as const, readiness: 'ready' as const, capabilities: { discovery: true, output: true, actions: true, attach: true, create: false }, sourceLaneRevision: laneState[lane].sourceLaneRevision, lastOkGlobalRevision: laneState[lane].health.lastOkRevision ?? 0, coverage: laneState[lane].health.ok ? 'authoritative' as const : 'retained' as const, consecutiveFailures: laneState[lane].health.consecutiveFailures })),
      ...runtimeSources,
    ];
    const coverage = (lane: DiscoveryLane): LaneCoverage => {
      const sources = sourceLanes.filter((source) => source.lane === lane);
      const keys = sources.map((source) => sourceLaneKey(source.lane, source.sourceId));
      const authoritative = sources.filter((source) => source.coverage === 'authoritative').map((source) => sourceLaneKey(source.lane, source.sourceId));
      const retained = sources.filter((source) => source.coverage === 'retained').map((source) => sourceLaneKey(source.lane, source.sourceId));
      const unavailable = sources.filter((source) => source.coverage === 'none').map((source) => sourceLaneKey(source.lane, source.sourceId));
      return { lane, state: unavailable.length || retained.length ? (authoritative.length ? 'partial' : retained.length ? 'partial' : 'unavailable') : 'complete', expectedSourceLaneKeys: keys, authoritativeSourceLaneKeys: authoritative, retainedSourceLaneKeys: retained, unavailableSourceLaneKeys: unavailable };
    };
    return { version: 2, epoch, globalRevision: revision, terminals, tmuxRows: [...rows.values()].map(({ lastSeenRevision: _lastSeenRevision, staleSinceRevision: _staleSinceRevision, ...row }) => row), sourceDescriptors: [{ runtime: 'tmux', sourceId: 'tmux.local', readiness: 'ready' }, ...runtimeDescriptors.filter((source) => source.runtime === 'herdr')], sourceLanes, coverageByLane: { external: coverage('external'), live: coverage('live') } };
  }

  function makeSnapshot(takenAtMs: number): DiscoverySnapshot {
    const health = Object.freeze({
      external: Object.freeze({ ...laneState.external.health }),
      live: Object.freeze({ ...laneState.live.health }),
    });
    const v2 = runtimeProjection();
    return Object.freeze({
      epoch,
      revision,
      takenAtMs,
      rows: Object.freeze([...rows.values()].sort((a, b) => a.key.localeCompare(b.key)).map(freezeRow)),
      health,
      ...(v2 ? { v2: Object.freeze(v2) } : {}),
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
  function applyRuntimeAvailable(sourceId: string, terminals: readonly PublicTerminalTarget[]): boolean {
    const next = new Map(runtimeRows);
    const found = new Map(terminals
      .filter((terminal): terminal is Extract<PublicTerminalTarget, { runtime: 'herdr' }> => terminal.runtime === 'herdr' && terminal.sourceId === sourceId)
      .map((terminal) => [publicTerminalKey('external', terminal), terminal]));
    let changed = false;
    for (const [key, previous] of runtimeRows) {
      if (previous.sourceId !== sourceId) continue;
      const terminal = found.get(key);
      if (terminal) {
        if (previous.presence !== 'present' || previous.staleSinceRevision !== null || JSON.stringify(previous.terminal) !== JSON.stringify(terminal)) {
          next.set(key, { ...previous, terminal, lastSeenRevision: revision + 1, presence: 'present', staleSinceRevision: null });
          changed = true;
        }
        found.delete(key);
        runtimeMissingTicks.delete(key);
      } else if (previous.presence === 'present') {
        runtimeMissingTicks.set(key, 1);
        next.set(key, { ...previous, presence: 'stale', staleSinceRevision: revision + 1 });
        changed = true;
      } else {
        const misses = (runtimeMissingTicks.get(key) ?? 1) + 1;
        runtimeMissingTicks.set(key, misses);
        if (misses >= GRACE_TICKS_EXTERNAL) {
          runtimeMissingTicks.delete(key);
          next.delete(key);
          changed = true;
        }
      }
    }
    for (const [key, terminal] of found) {
      next.set(key, { lane: 'external', sourceId, terminal, lastSeenRevision: revision + 1, presence: 'present', staleSinceRevision: null });
      changed = true;
    }
    if (changed) {
      runtimeRows.clear();
      for (const [key, value] of next) runtimeRows.set(key, value);
    }
    return changed;
  }

  function applyRuntimeUnavailable(sourceId: string): boolean {
    const state = runtimeState(sourceId);
    state.disabled = false;
    state.failures += 1;
    state.health = { ok: false, lastOkRevision: state.health.lastOkRevision, consecutiveFailures: state.failures };
    const changed = true;
    const next = new Map(runtimeRows);
    for (const [key, row] of runtimeRows) {
      if (row.sourceId !== sourceId) continue;
      if (state.failures >= HERDR_UNAVAILABLE_GRACE_TICKS_EXTERNAL) {
        next.delete(key);
        runtimeMissingTicks.delete(key);
      } else if (row.presence === 'present') {
        next.set(key, { ...row, presence: 'stale', staleSinceRevision: revision + 1 });
      }
    }
    if (next.size !== runtimeRows.size || [...next].some(([key, row]) => runtimeRows.get(key) !== row)) {
      runtimeRows.clear();
      for (const [key, row] of next) runtimeRows.set(key, row);
    }
    return changed;
  }
  function applyRuntimeDisabled(sourceId: string): boolean {
    const state = runtimeState(sourceId);
    const changed = !state.disabled || state.health.ok || state.health.consecutiveFailures !== 0
      || [...runtimeRows.values()].some((row) => row.sourceId === sourceId);
    state.disabled = true;
    state.failures = 0;
    state.health = { ok: false, lastOkRevision: state.health.lastOkRevision, consecutiveFailures: 0 };
    for (const [key, row] of runtimeRows) {
      if (row.sourceId === sourceId) {
        runtimeRows.delete(key);
        runtimeMissingTicks.delete(key);
      }
    }
    return changed;
  }

  function applyRuntimeSuccess(sourceId: string): boolean {
    const state = runtimeState(sourceId);
    const changed = state.disabled || !state.health.ok || state.health.lastOkRevision === null || state.health.consecutiveFailures !== 0;
    state.disabled = false;
    state.failures = 0;
    if (changed) state.health = { ok: true, lastOkRevision: revision + 1, consecutiveFailures: 0 };
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
      || runtimeRegistry !== undefined
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

      const [external, live, runtime] = await Promise.all([
        scanExternal().catch(() => ({ ok: false, sessions: [] })),
        scanLive().catch(() => ({ ok: false, sessions: [] })),
        runtimeRegistry
          ? (runtimeRegistry.scanDiscovery
            ? runtimeRegistry.scanDiscovery().then(
              ({ sources, outcomes }) => ({
                sources: { ok: true as const, sources: [...sources] },
                outcomes: { ok: true as const, outcomes: [...outcomes] },
              }),
              () => ({
                sources: { ok: false as const, sources: [] as SourceDescriptor[] },
                outcomes: { ok: false as const, outcomes: [] as DiscoveryRuntimeOutcome[] },
              }),
            )
            : Promise.all([
              runtimeRegistry.sources().then((sources) => ({ ok: true as const, sources }), () => ({ ok: false as const, sources: [] as SourceDescriptor[] })),
              runtimeRegistry.discoverOutcomes().then((outcomes) => ({ ok: true as const, outcomes }), () => ({ ok: false as const, outcomes: [] as DiscoveryRuntimeOutcome[] })),
            ]).then(([sources, outcomes]) => ({ sources, outcomes })))
          : Promise.resolve(null),
      ]);
      if (disposed) return;
      const takenAtMs = now();
      detailed = Object.freeze({ takenAtMs, external, live });
      let changed = false;
      let externalChanged: boolean;
      if (external.ok) {
        externalChanged = applyKnownSuccess('external');
        externalChanged = applyAvailable('external', await externalRows(external.sessions)) || externalChanged;
      } else {
        externalChanged = applyUnavailable('external');
      }
      if (externalChanged) laneState.external.sourceLaneRevision += 1;
      changed = externalChanged || changed;
      let liveChanged: boolean;
      if (live.ok) {
        liveChanged = applyKnownSuccess('live');
        liveChanged = applyAvailable('live', liveRows(live.sessions)) || liveChanged;
      } else {
        liveChanged = applyUnavailable('live');
      }
      if (liveChanged) laneState.live.sourceLaneRevision += 1;
      changed = liveChanged || changed;
      if (runtime) {
        if (runtime.sources.ok) runtimeDescriptors = runtime.sources.sources.filter((source) => source.runtime === 'herdr');
        const expectedSources = new Map(runtimeDescriptors.map((source) => [source.sourceId, source]));
        for (const key of sourceStates.keys()) {
          const sourceId = key.split('\0')[1]!;
          if (!expectedSources.has(sourceId)) expectedSources.set(sourceId, { runtime: 'herdr', sourceId, readiness: 'offline' });
        }
        const outcomes = new Map<string, DiscoveryRuntimeOutcome>();
        if (runtime.outcomes.ok) {
          for (const outcome of runtime.outcomes.outcomes) {
            if (outcome.runtime !== 'herdr' || outcomes.has(outcome.sourceId)) continue;
            outcomes.set(outcome.sourceId, outcome);
          }
        }
        for (const [sourceId, source] of expectedSources) {
          const outcome = outcomes.get(sourceId);
          const capable = runtimeRegistry!.capabilities('herdr', sourceId).discovery;
          let pairChanged: boolean;
          if (source.readiness === 'disabled' || !capable) {
            pairChanged = applyRuntimeDisabled(sourceId);
          } else if (source.readiness === 'ready' && outcome?.ok === true) {
            pairChanged = applyRuntimeSuccess(sourceId);
            pairChanged = applyRuntimeAvailable(sourceId, outcome.terminals) || pairChanged;
          } else {
            pairChanged = applyRuntimeUnavailable(sourceId);
          }
          if (pairChanged) runtimeState(sourceId).sourceLaneRevision += 1;
          changed = pairChanged || changed;
        }
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
