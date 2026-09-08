import { performance } from 'node:perf_hooks';

import type { DiscoveryCollector, DiscoveryRow, GjcWatcherHealth, SessionIndexingDiagnostics, getCachedHostDiscoverySnapshot } from '@/modules/providers/index.js';

import type { DiagnosticsLane, OwnerDiagnostics, DiagnosticsPaneObservation, DiagnosticsLineageReason, OwnerPaneDiagnostics } from '../../../shared/diagnostics.js';
import { PROVIDER_CONNECTION_ISSUE_CODES } from '../../../shared/provider-connection.js';
import { tmuxPaneIdentityKey, type TmuxPaneIdentity } from "../../../shared/tmux.js";

export const DIAGNOSTICS_CACHE_TTL_MS = 2_000;
export const DIAGNOSTICS_STALE_AFTER_MS = 30_000;
export const DIAGNOSTICS_MAX_ROWS = 1_000;
export const DIAGNOSTICS_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
const MAX_COUNT = 1_000_000;

type CachedCollector = Pick<DiscoveryCollector, 'currentSnapshot' | 'currentDetailed' | 'getState'>;
export type DiagnosticsDependencies = {
  collector: () => CachedCollector | null | undefined;
  watcher: () => GjcWatcherHealth | null | undefined;
  /** Cached counters only. This dependency must not scan, reconcile, or start work. */
  indexing?: () => Readonly<SessionIndexingDiagnostics> | null | undefined;
  now?: () => number;
  eventLoopUtilization?: () => number;
};

function count(value: number): number {
  return Number.isFinite(value) ? Math.min(MAX_COUNT, Math.max(0, Math.floor(value))) : 0;
}

function age(now: number, takenAt: number | null | undefined): number | null {
  if (typeof takenAt !== 'number' || !Number.isFinite(takenAt) || takenAt < 0 || takenAt > now) return null;
  return Math.min(DIAGNOSTICS_MAX_AGE_MS, Math.floor(now - takenAt));
}

function waitingLane(): DiagnosticsLane {
  return { status: 'waiting', consecutiveFailures: 0, rows: 0, staleRows: 0 };
}

function unavailableCollector(): OwnerDiagnostics['collector'] {
  return {
    status: 'unavailable', mode: 'unknown', scanning: false, freshness: 'unavailable',
    scanAgeMs: null, fullScanAgeMs: null, staleAfterMs: DIAGNOSTICS_STALE_AFTER_MS,
    rowsTruncated: false, lanes: { external: waitingLane(), live: waitingLane() }, connectionIssues: [],
  };
}

function summarizeCollector(collector: CachedCollector | null | undefined, now: number): OwnerDiagnostics['collector'] {
  if (!collector) return unavailableCollector();
  // These methods only return existing metadata. Do not use ensureFresh/tick here.
  const snapshot = collector.currentSnapshot();
  const detailed = collector.currentDetailed();
  const state = collector.getState?.();
  const scanAgeMs = age(now, detailed.takenAtMs);
  const lanes = { external: waitingLane(), live: waitingLane() };
  for (const lane of ['external', 'live'] as const) {
    const failures = count(state?.consecutiveFailures[lane] ?? snapshot.health[lane].consecutiveFailures);
    lanes[lane].consecutiveFailures = failures;
    lanes[lane].status = detailed[lane] === null ? 'waiting'
      : !snapshot.health[lane].ok ? 'degraded'
      : detailed[lane].ok === false || failures > 0 ? 'failing' : 'ok';
  }
  const issueCounts = new Map<string, number>();
  for (const row of snapshot.rows.slice(0, DIAGNOSTICS_MAX_ROWS)) {
    if (row.lane !== 'external' && row.lane !== 'live') continue;
    lanes[row.lane].rows += 1;
    if (row.presence === 'stale') lanes[row.lane].staleRows += 1;
    if (typeof row.connectionIssue === 'string') {
      // Only fixed, known reason codes survive the projection below.
      if (PROVIDER_CONNECTION_ISSUE_CODES.some((code) => code === row.connectionIssue)) {
        issueCounts.set(row.connectionIssue, (issueCounts.get(row.connectionIssue) ?? 0) + 1);
      }
    }
  }
  return {
    status: 'available',
    mode: !state ? 'unknown' : state.disposed ? 'disposed' : !state.running ? 'stopped' : state.active ? 'active' : 'idle',
    scanning: state?.scanning === true,
    freshness: detailed.takenAtMs === null ? 'waiting'
      : scanAgeMs === null ? 'unavailable' : scanAgeMs > DIAGNOSTICS_STALE_AFTER_MS ? 'stale' : 'fresh',
    scanAgeMs,
    fullScanAgeMs: age(now, state?.lastFullScanAtMs),
    staleAfterMs: DIAGNOSTICS_STALE_AFTER_MS,
    rowsTruncated: snapshot.rows.length > DIAGNOSTICS_MAX_ROWS,
    lanes,
    connectionIssues: PROVIDER_CONNECTION_ISSUE_CODES.flatMap((code) => {
      const total = issueCounts.get(code) ?? 0;
      return total > 0 ? [{ code, count: total }] : [];
    }),
  };
}

function indexingCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? count(value) : null;
}

function summarizeIndexing(source?: Readonly<SessionIndexingDiagnostics> | null): OwnerDiagnostics['indexing'] {
  return {
    status: source?.closed === true ? 'closed' : source?.closed === false ? 'accepting' : 'unavailable',
    pending: indexingCount(source?.pending),
    active: indexingCount(source?.active),
    maxPending: indexingCount(source?.maxPending),
    maxActive: indexingCount(source?.maxActive),
    reconciling: indexingCount(source?.reconciling),
    reconciliationPending: indexingCount(source?.reconciliationPending),
    overflowed: indexingCount(source?.overflowed),
    failures: indexingCount(source?.failures),
  };
}

/** A bounded in-memory view. Owns no timers, listeners, subprocesses, or I/O. */
export function createDiagnosticsService(dependencies: DiagnosticsDependencies) {
  const now = dependencies.now ?? Date.now;
  const utilization = dependencies.eventLoopUtilization ?? (() => performance.eventLoopUtilization().utilization);
  let cached: OwnerDiagnostics | undefined;
  let cachedAt = 0;
  return {
    read(): OwnerDiagnostics {
      const sampledAt = now();
      if (cached && sampledAt >= cachedAt && sampledAt - cachedAt < DIAGNOSTICS_CACHE_TTL_MS) return cached;
      let collector = unavailableCollector();
      let gjcWatcher: OwnerDiagnostics['gjcWatcher'] = {
        status: 'unavailable', consecutiveFailures: 0, watchLimitObserved: false,
      };
      let indexing = summarizeIndexing();
      let eventLoopUtilization: number | null = null;
      // One broken source must not hide the remaining recovery signals. Never
      // serialize/log exception text: providers may include paths or secrets.
      try { collector = summarizeCollector(dependencies.collector(), sampledAt); } catch { /* unavailable */ }
      try {
        const watcher = dependencies.watcher();
        if (watcher) gjcWatcher = {
          status: watcher.degraded === true ? 'degraded'
            : watcher.ok === false || watcher.consecutiveFailures > 0 ? 'retrying' : 'no_failures_reported',
          consecutiveFailures: count(watcher.consecutiveFailures),
          watchLimitObserved: watcher.enospcObserved === true,
        };
      } catch { /* unavailable */ }
      try { indexing = summarizeIndexing(dependencies.indexing?.()); } catch { /* unavailable */ }
      try {
        const value = utilization();
        if (Number.isFinite(value) && value >= 0 && value <= 1) eventLoopUtilization = Math.round(value * 10_000) / 10_000;
      } catch { /* unavailable */ }
      cachedAt = sampledAt;
      cached = {
        schemaVersion: 1, generatedAtMs: Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(sampledAt))),
        cacheTtlMs: DIAGNOSTICS_CACHE_TTL_MS, collector, gjcWatcher, indexing,
        eventLoop: { utilization: eventLoopUtilization },
      };
      return cached;
    },
  };
}

type HostDiscoverySnapshot = NonNullable<ReturnType<typeof getCachedHostDiscoverySnapshot>>;
export type PaneDiagnosticsDependencies = {
  collector: () => CachedCollector | null | undefined;
  /** Last completed sample only. Never use get/getFresh or discovery mutations. */
  host: () => HostDiscoverySnapshot | null | undefined;
  now?: () => number;
};

const PANE_LIMITS = { discoveryRows: 1000, hostPanes: 1000, hostProcesses: 8192, lineagePids: 32 } as const;
const PANE_PROVIDERS = ["claude", "codex", "cursor", "opencode", "omp", "omo", "gjc", "ssh", "shell"] as const;
const SOCKET_ISSUES = ["configuration_invalid", "socket_unavailable", "socket_identity_changed", "capture_failed", "cancelled"] as const;

function publicPid(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 2147483647 ? value : null;
}

function publicPaneIdentity(tmux: TmuxPaneIdentity): boolean {
  // No trimming/coercion: only literal ASCII coordinates may leave this boundary.
  return typeof tmux.socketPath === "string" && tmux.socketPath.length > 0
    && typeof tmux.sessionId === "string" && /^\$[0-9]{1,10}$/.test(tmux.sessionId)
    && typeof tmux.windowId === "string" && /^@[0-9]{1,10}$/.test(tmux.windowId)
    && typeof tmux.paneId === "string" && /^%[0-9]{1,10}$/.test(tmux.paneId);
}

function socketIssue(value: unknown): OwnerPaneDiagnostics["host"]["failure"] {
  return value === undefined || value === null ? null : SOCKET_ISSUES.find((code) => code === value) ?? "unknown";
}

type PaneHostEvidence = {
  available: boolean;
  capturedAtMs: number;
  panes: Map<string, { pid: number | null; slot: number | null }>;
  parents: Map<number, number | null>;
};

function cachedLineage(row: DiscoveryRow, host: PaneHostEvidence, now: number): DiagnosticsPaneObservation["process"] {
  const agentPid = publicPid(row.process?.pid);
  const startedAt = row.process?.startedAtMs;
  const generation = agentPid !== null && age(now, startedAt) !== null ? "recorded" : "unknown";
  const unknown = (reason: DiagnosticsLineageReason): DiagnosticsPaneObservation["process"] => ({
    agentPid, generation, lineage: { relation: "unknown", reason, pids: [] },
  });
  if (!host.available) return unknown("host_unavailable");
  const pane = host.panes.get(tmuxPaneIdentityKey(row.tmux));
  if (!pane) return unknown("pane_not_observed");
  if (agentPid === null || generation === "unknown" || startedAt === undefined) return unknown("process_not_recorded");
  if (host.capturedAtMs < startedAt) return unknown("sample_predates_generation");
  if (!host.parents.has(agentPid)) return unknown("process_not_observed");
  if (pane.pid === null) return unknown("ancestry_incomplete");
  const chain: number[] = [];
  const seen = new Set<number>();
  let pid = agentPid;
  while (true) {
    if (seen.has(pid)) return unknown("ancestry_cycle");
    if (chain.length === PANE_LIMITS.lineagePids) return unknown("ancestry_limit");
    if (!host.parents.has(pid)) return unknown("ancestry_incomplete");
    seen.add(pid);
    chain.push(pid);
    if (pid === pane.pid) return {
      agentPid, generation,
      lineage: { relation: pid === agentPid ? "pane_root" : "descendant", reason: null, pids: chain.reverse() },
    };
    const parent = host.parents.get(pid);
    if (parent === 0) return unknown("not_in_pane_chain");
    if (parent === null || parent === undefined) return unknown("ancestry_incomplete");
    pid = parent;
  }
}

function paneFreshness(row: DiscoveryRow, collector: OwnerPaneDiagnostics["collector"]): DiagnosticsPaneObservation["freshness"] {
  const lane = collector.lanes[row.lane].status;
  const ages = [collector.scanAgeMs, collector.fullScanAgeMs];
  if (row.presence === "stale" || lane === "failing" || lane === "degraded"
    || ages.some((value) => value !== null && value > DIAGNOSTICS_STALE_AFTER_MS)) return "stale";
  return lane === "ok" && ages.every((value) => value !== null) ? "fresh" : "unknown";
}

/** Independent, bounded owner display cache. Has no capture, control, timer or I/O dependency. */
export function createPaneDiagnosticsService(dependencies: PaneDiagnosticsDependencies) {
  const now = dependencies.now ?? Date.now;
  let cached: OwnerPaneDiagnostics | undefined;
  let cachedAt = 0;
  return {
    read(): OwnerPaneDiagnostics {
      const sampledAt = now();
      if (cached && sampledAt >= cachedAt && sampledAt - cachedAt < DIAGNOSTICS_CACHE_TTL_MS) return cached;
      let rows: readonly DiscoveryRow[] = [];
      let summary = unavailableCollector();
      let countsCapped = false;
      const boundedCount = (value: number): number => {
        if (value > MAX_COUNT) countsCapped = true;
        return count(value);
      };
      // Source exceptions become explicit unavailable evidence, never exception text/logs.
      try {
        const collector = dependencies.collector();
        if (collector) {
          const snapshot = collector.currentSnapshot();
          const detailed = collector.currentDetailed();
          const state = collector.getState?.();
          summary = summarizeCollector({ currentSnapshot: () => snapshot, currentDetailed: () => detailed,
            ...(state ? { getState: () => state } : {}) }, sampledAt);
          rows = snapshot.rows;
          for (const lane of ["external", "live"] as const) {
            boundedCount(state?.consecutiveFailures[lane] ?? snapshot.health[lane].consecutiveFailures);
          }
        }
      } catch { summary = unavailableCollector(); rows = []; }
      const collector: OwnerPaneDiagnostics["collector"] = {
        status: summary.status, freshness: summary.freshness, scanAgeMs: summary.scanAgeMs,
        fullScanAgeMs: summary.fullScanAgeMs, lanes: summary.lanes,
      };
      let source: HostDiscoverySnapshot | null | undefined;
      try { source = dependencies.host(); } catch { source = null; }
      const hostAge = source ? age(sampledAt, source.capturedAtMs) : null;
      const host: OwnerPaneDiagnostics["host"] = {
        freshness: hostAge === null ? "unavailable" : hostAge > DIAGNOSTICS_STALE_AFTER_MS ? "stale" : "fresh",
        ageMs: hostAge, capture: !source ? "unknown" : source.ok ? "ok"
          : source.sockets?.some((socket) => socket.ok) ? "partial" : "failed",
        failure: socketIssue(source?.failure), sockets: [],
      };
      const evidence: PaneHostEvidence = {
        available: hostAge !== null && (host.capture === "ok" || host.capture === "partial"),
        capturedAtMs: source?.capturedAtMs ?? 0, panes: new Map(), parents: new Map(),
      };
      const slots = new Map<string, number>();
      let slotPanesInspected = 0;
      for (const [index, socket] of (source?.sockets ?? []).entries()) {
        host.sockets.push({ slot: index + 1, capture: socket.ok ? "ok" : "unavailable",
          reason: socketIssue(socket.reason), paneCount: boundedCount(socket.panes.length) });
        if (!socket.ok) continue;
        const length = Math.min(socket.panes.length, PANE_LIMITS.hostPanes - slotPanesInspected);
        for (let i = 0; i < length; i++) {
          const pane = socket.panes[i];
          slots.set(tmuxPaneIdentityKey(pane.tmux), index + 1);
        }
        slotPanesInspected += length;
      }
      for (const pane of source?.panes.slice(0, PANE_LIMITS.hostPanes) ?? []) {
        if (!publicPaneIdentity(pane.tmux)) continue;
        const key = tmuxPaneIdentityKey(pane.tmux);
        evidence.panes.set(key, { pid: publicPid(pane.pid), slot: slots.get(key) ?? null });
      }
      for (const process of source?.processes.slice(0, PANE_LIMITS.hostProcesses) ?? []) {
        const pid = publicPid(process.pid);
        if (pid !== null) evidence.parents.set(pid, process.ppid === 0 ? 0 : publicPid(process.ppid));
      }
      const coverage: OwnerPaneDiagnostics["coverage"] = {
        totalRows: summary.status === "unavailable" ? null : boundedCount(rows.length),
        rowsInspected: Math.min(rows.length, PANE_LIMITS.discoveryRows),
        rowsOmitted: boundedCount(Math.max(0, rows.length - PANE_LIMITS.discoveryRows)), invalidRowsOmitted: 0,
        hostPanesOmitted: boundedCount(Math.max(0, (source?.panes.length ?? 0) - PANE_LIMITS.hostPanes)),
        hostProcessesOmitted: boundedCount(Math.max(0, (source?.processes.length ?? 0) - PANE_LIMITS.hostProcesses)), countsCapped: false,
      };
      const panes = new Map<string, OwnerPaneDiagnostics["panes"][number]>();
      const sockets = new Map<string, number>();
      for (const row of rows.slice(0, PANE_LIMITS.discoveryRows)) {
        if (!publicPaneIdentity(row.tmux) || (row.lane !== "external" && row.lane !== "live")
          || (row.presence !== "present" && row.presence !== "stale")) { coverage.invalidRowsOmitted++; continue; }
        const key = tmuxPaneIdentityKey(row.tmux);
        let pane = panes.get(key);
        if (!pane) {
          const socketNumber = sockets.get(row.tmux.socketPath) ?? sockets.size + 1;
          sockets.set(row.tmux.socketPath, socketNumber);
          const captured = evidence.panes.get(key);
          pane = { paneNumber: panes.size + 1, socketNumber, captureSlot: captured?.slot ?? null,
            sessionId: row.tmux.sessionId, windowId: row.tmux.windowId, paneId: row.tmux.paneId,
            panePid: captured?.pid ?? null, observations: [] };
          panes.set(key, pane);
        }
        if (pane.observations.some((observation) => observation.lane === row.lane)) continue;
        pane.observations.push({
          lane: row.lane, provider: PANE_PROVIDERS.find((value) => value === row.kind) ?? "unknown",
          presence: row.presence, freshness: paneFreshness(row, collector),
          activity: (["running", "waiting_user", "asking_user", "error"] as const).find((value) => value === row.activity) ?? "unknown",
          connectionIssue: row.connectionIssue === undefined || row.connectionIssue === null ? null
            : PROVIDER_CONNECTION_ISSUE_CODES.find((value) => value === row.connectionIssue) ?? "unknown",
          actionabilityReport: row.tmuxActionable === true ? "reported_true" : row.tmuxActionable === false ? "reported_false" : "unknown",
          binding: {
            grade: (["tagged", "observed", "inferred"] as const).find((value) => value === row.binding) ?? "unknown",
            providerSessionReported: typeof row.providerSessionId === "string" && row.providerSessionId.length > 0
              && !row.providerSessionId.startsWith("idle-gjc:"),
          },
          process: cachedLineage(row, evidence, sampledAt),
        });
      }
      coverage.countsCapped = countsCapped;
      cachedAt = sampledAt;
      cached = { schemaVersion: 1, generatedAtMs: Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(sampledAt))),
        cacheTtlMs: DIAGNOSTICS_CACHE_TTL_MS, staleAfterMs: DIAGNOSTICS_STALE_AFTER_MS,
        collector, host, limits: { ...PANE_LIMITS }, coverage, panes: [...panes.values()] };
      return cached;
    },
  };
}
