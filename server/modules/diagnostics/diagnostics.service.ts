import { performance } from 'node:perf_hooks';

import type { DiscoveryCollector, GjcWatcherHealth, SessionIndexingDiagnostics } from '@/modules/providers/index.js';

import type { DiagnosticsLane, OwnerDiagnostics } from '../../../shared/diagnostics.js';
import { PROVIDER_CONNECTION_ISSUE_CODES } from '../../../shared/provider-connection.js';

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
