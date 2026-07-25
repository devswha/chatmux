import { randomUUID } from 'node:crypto';

import {
  tmuxPaneIdentityKey,
  type TmuxPaneIdentity,
  type TmuxProcessGeneration,
} from '../../../../shared/tmux.js';

import {
  getExternalCliSessionsDetailed,
  type ExternalCliSession,
  type ExternalCliSessionsDetailedResult,
} from './external-cli-sessions.service.js';
import { resolveExternalSessionActivity } from './external-session-activity.service.js';
import {
  getLiveGjcSessionsDetailed,
  type LiveGjcSession,
  type LiveGjcSessionsDetailedResult,
} from './live-sessions.service.js';

export const C_SCAN_MS = 1_000;
export const C_SCAN_IDLE_MS = 8_000;
export const FORCE_REFRESH_DEBOUNCE_MS = 250;
export const GRACE_TICKS_LIVE = 5;
export const GRACE_TICKS_EXTERNAL = 2;
export const UNAVAILABLE_DEGRADE_TICKS = 30;

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
  activity: 'running' | 'waiting_user' | 'asking_user' | 'unknown';
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

export type DiscoveryCollectorOptions = {
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearTimer?: (timer: ReturnType<typeof setInterval>) => void;
  scanExternal?: () => Promise<ExternalCliSessionsDetailedResult>;
  scanLive?: () => Promise<DiscoveryLiveScanResult>;
};

export type DiscoveryCollector = {
  start(): void;
  stop(): void;
  dispose(): void;
  setActive(active: boolean): void;
  forceRefresh(): void;
  tick(): Promise<void>;
  currentSnapshot(): DiscoverySnapshot;
  onSnapshot(listener: (snapshot: DiscoverySnapshot) => void): () => void;
};

type LaneState = {
  failures: number;
  health: DiscoveryLaneHealth;
};

function rowKey(lane: DiscoveryLane, tmux: TmuxPaneIdentity): DiscoveryRowKey {
  return `${lane}\0${tmuxPaneIdentityKey(tmux)}`;
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
    && a.activity === b.activity
    && a.cwd === b.cwd
    && a.presence === b.presence
    && a.staleSinceRevision === b.staleSinceRevision;
}

function defaultLiveScan(): Promise<DiscoveryLiveScanResult> {
  return getLiveGjcSessionsDetailed().then(({ ok, sessions }) => ({ ok, sessions }));
}

export function createDiscoveryCollector(options: DiscoveryCollectorOptions = {}): DiscoveryCollector {
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? setInterval;
  const clearTimer = options.clearTimer ?? clearInterval;
  const scanExternal = options.scanExternal ?? getExternalCliSessionsDetailed;
  const scanLive = options.scanLive ?? defaultLiveScan;
  const epoch = randomUUID();
  let revision = 0;
  let rows = new Map<DiscoveryRowKey, DiscoveryRow>();
  const missingTicks = new Map<DiscoveryRowKey, number>();
  const laneState: Record<DiscoveryLane, LaneState> = {
    external: { failures: 0, health: { ok: true, lastOkRevision: null, consecutiveFailures: 0 } },
    live: { failures: 0, health: { ok: true, lastOkRevision: null, consecutiveFailures: 0 } },
  };
  let timer: ReturnType<typeof setInterval> | null = null;
  let forceTimer: ReturnType<typeof setInterval> | null = null;
  let active = false;
  let inFlight = false;
  let disposed = false;
  const listeners = new Set<(next: DiscoverySnapshot) => void>();
  let snapshot = makeSnapshot(now());

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
    return Promise.all(sessions.map(async (session) => ({
      key: rowKey('external', session.tmux),
      lane: 'external' as const,
      tmuxName: session.tmuxName,
      tmux: session.tmux,
      process: session.agentPid === undefined || session.startedAtMs === undefined
        ? null
        : { pid: session.agentPid, startedAtMs: session.startedAtMs },
      kind: session.kind,
      providerSessionId: session.providerSessionId ?? null,
      activity: (await resolveExternalSessionActivity(session)).activity,
      cwd: session.cwd ?? null,
      lastSeenRevision: revision,
      presence: 'present' as const,
      staleSinceRevision: null,
    })));
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
        activity: session.running === true ? 'running' : 'unknown',
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
    let changed = false;
    const grace = lane === 'live' ? GRACE_TICKS_LIVE : GRACE_TICKS_EXTERNAL;

    for (const [key, previous] of rows) {
      if (previous.lane !== lane) continue;
      const observed = found.get(key);
      if (observed) {
        const candidate = { ...observed, lastSeenRevision: revision + 1 };
        const replacement = sameRow(previous, candidate) ? previous : candidate;
        if (replacement !== previous) {
          next.set(key, replacement);
          changed = true;
        }
        found.delete(key);
        missingTicks.delete(key);
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
          next.delete(key);
          changed = true;
        }
      }
    }
    for (const [key, row] of found) {
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

  async function tick(): Promise<void> {
    if (disposed || inFlight) return;
    inFlight = true;
    try {
      const [external, live] = await Promise.all([
        scanExternal().catch(() => ({ ok: false, sessions: [] })),
        scanLive().catch(() => ({ ok: false, sessions: [] })),
      ]);
      if (disposed) return;
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
      snapshot = makeSnapshot(now());
      for (const listener of listeners) listener(snapshot);
    } finally {
      inFlight = false;
    }
  }

  function schedule(): void {
    if (timer) clearTimer(timer);
    timer = setTimer(() => { void tick(); }, active ? C_SCAN_MS : C_SCAN_IDLE_MS);
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
        void tick();
      }, FORCE_REFRESH_DEBOUNCE_MS);
    },
    tick,
    currentSnapshot: () => snapshot,
    onSnapshot(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
