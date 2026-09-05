import type { ProviderConnectionIssue } from './provider-connection.js';

/** Display-only aggregates. No session, pane, process, or action identities. */
export type DiagnosticsLane = {
  status: 'waiting' | 'ok' | 'failing' | 'degraded';
  consecutiveFailures: number;
  rows: number;
  staleRows: number;
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
  eventLoop: {
    /** Cumulative since process start; not CPU usage or a latency measurement. */
    utilization: number | null;
  };
};
