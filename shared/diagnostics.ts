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

export type DiagnosticsSocketIssue =
  | 'configuration_invalid'
  | 'socket_unavailable'
  | 'socket_identity_changed'
  | 'capture_failed'
  | 'cancelled';

export type DiagnosticsProvider =
  | 'claude' | 'codex' | 'cursor' | 'opencode'
  | 'omp' | 'omo' | 'gjc' | 'ssh' | 'shell' | 'unknown';

export type DiagnosticsLineageReason =
  | 'host_unavailable'
  | 'pane_not_observed'
  | 'process_not_recorded'
  | 'process_not_observed'
  | 'sample_predates_generation'
  | 'ancestry_incomplete'
  | 'ancestry_cycle'
  | 'ancestry_limit'
  | 'not_in_pane_chain';

export type DiagnosticsPaneObservation = {
  lane: 'external' | 'live';
  provider: DiagnosticsProvider;
  presence: 'present' | 'stale';
  freshness: 'fresh' | 'stale' | 'unknown';
  activity: 'running' | 'waiting_user' | 'asking_user' | 'error' | 'unknown';
  connectionIssue: ProviderConnectionIssue | 'unknown' | null;
  actionabilityReport: 'reported_true' | 'reported_false' | 'unknown';
  binding: {
    grade: 'tagged' | 'observed' | 'inferred' | 'unknown';
    providerSessionReported: boolean;
  };
  process: {
    agentPid: number | null;
    generation: 'recorded' | 'unknown';
    lineage: {
      relation: 'pane_root' | 'descendant' | 'unknown';
      reason: DiagnosticsLineageReason | null;
      /** Pane-root-to-agent order; empty unless relation was observed. */
      pids: number[];
    };
  };
};

export type OwnerPaneDiagnostics = {
  schemaVersion: 1;
  generatedAtMs: number;
  cacheTtlMs: 2000;
  staleAfterMs: 30000;
  collector: Pick<
    OwnerDiagnostics['collector'],
    'status' | 'freshness' | 'scanAgeMs' | 'fullScanAgeMs' | 'lanes'
  >;
  host: {
    freshness: 'fresh' | 'stale' | 'unavailable';
    ageMs: number | null;
    capture: 'ok' | 'partial' | 'failed' | 'unknown';
    failure: DiagnosticsSocketIssue | 'unknown' | null;
    sockets: {
      slot: number;
      capture: 'ok' | 'unavailable';
      reason: DiagnosticsSocketIssue | 'unknown' | null;
      paneCount: number;
    }[];
  };
  limits: {
    discoveryRows: 1000;
    hostPanes: 1000;
    hostProcesses: 8192;
    lineagePids: 32;
  };
  coverage: {
    totalRows: number | null;
    rowsInspected: number;
    rowsOmitted: number;
    invalidRowsOmitted: number;
    hostPanesOmitted: number;
    hostProcessesOmitted: number;
    countsCapped: boolean;
  };
  panes: {
    paneNumber: number;
    socketNumber: number;
    captureSlot: number | null;
    sessionId: string;
    windowId: string;
    paneId: string;
    panePid: number | null;
    /** At most one observation per lane. */
    observations: DiagnosticsPaneObservation[];
  }[];
};
