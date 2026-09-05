import type { ProviderConnectionIssue } from './provider-connection.js';

/** Display-only aggregates. No session, pane, process, or action identities. */
export type DiagnosticsLane = {
  status: 'waiting' | 'ok' | 'failing' | 'degraded';
  consecutiveFailures: number;
  rows: number;
  staleRows: number;
};

/** Fixed aggregate fields only; counters are capped at 1,000,000 or null. */
export type DiagnosticsIndexing = {
  /** Admission state, not watcher/agent liveness. Startup may pause an accepting queue. */
  status: 'accepting' | 'closed' | 'unavailable';
  pending: number | null;
  active: number | null;
  maxPending: number | null;
  maxActive: number | null;
  /** Active reconciliation steps and providers with a recovery pass pending/in progress. */
  reconciling: number | null;
  reconciliationPending: number | null;
  /** Cumulative for the current scheduler instance, not consecutive failures. */
  overflowed: number | null;
  failures: number | null;
};

export type OwnerDiagnostics = {
  schemaVersion: 1;
  generatedAtMs: number;
  cacheTtlMs: number;
  collector: {
    status: 'available' | 'unavailable';
    mode: 'active' | 'idle' | 'stopped' | 'disposed' | 'unknown';
    scanning: boolean;
    freshness: 'waiting' | 'fresh' | 'stale' | 'unavailable';
    scanAgeMs: number | null;
    fullScanAgeMs: number | null;
    staleAfterMs: number;
    rowsTruncated: boolean;
    lanes: Record<'external' | 'live', DiagnosticsLane>;
    connectionIssues: { code: ProviderConnectionIssue; count: number }[];
  };
  gjcWatcher: {
    /** The existing getter reports failures, not proof of a running watcher. */
    status: 'no_failures_reported' | 'retrying' | 'degraded' | 'unavailable';
    consecutiveFailures: number;
    watchLimitObserved: boolean;
  };
  /** Downstream file scheduling only; initial bulk synchronization is excluded. */
  indexing: DiagnosticsIndexing;
  eventLoop: {
    /** Cumulative since process start; not CPU usage or a latency measurement. */
    utilization: number | null;
  };
};
