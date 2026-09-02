import type { FleetCapability, FleetErrorCode, FleetLane } from '../../../../shared/fleet.js';
import type { TmuxPaneIdentity, TmuxProcessGeneration } from '../../../../shared/tmux.js';

export type FleetCatalogHost = Readonly<{
  readonly hostId: string;
  readonly displayLabel: string;
  readonly capabilities: readonly FleetCapability[];
}>;
export type FleetCatalogProject = Readonly<{
  readonly localId: string;
  readonly path: string;
  readonly displayName: string;
  readonly isStarred: boolean;
}>;
export type FleetCatalogSession = Readonly<{
  readonly localId: string;
  readonly projectLocalId: string;
  readonly provider: string;
  readonly summary: string;
  readonly lastActivityMs: number;
}>;
export type FleetCatalogPane = Readonly<{
  readonly localId: string;
  readonly lane: FleetLane;
  readonly tmuxName: string;
  readonly tmux: TmuxPaneIdentity;
  readonly process: TmuxProcessGeneration | null;
  readonly kind: string;
  readonly providerSessionId: string | null;
  readonly activity: string;
  readonly cwd: string | null;
  readonly presence: 'present' | 'stale';
}>;
export type FleetCatalogLaneHealth = Readonly<{
  readonly ok: boolean;
  readonly lastOkRevision: number | null;
  readonly consecutiveFailures: number;
}>;
export type FleetCatalogHealth = Readonly<{
  readonly external: FleetCatalogLaneHealth;
  readonly live: FleetCatalogLaneHealth;
}>;
export type FleetCatalogProcessing = Readonly<{
  readonly localId: string;
  readonly provider: string;
  readonly startedAtMs: number;
  readonly lastSeq: number;
}>;
export type FleetCatalogMaterial = Readonly<{
  readonly host: FleetCatalogHost;
  readonly projects: readonly FleetCatalogProject[];
  readonly sessions: readonly FleetCatalogSession[];
  readonly panes: readonly FleetCatalogPane[];
  readonly health: FleetCatalogHealth;
  readonly processing: readonly FleetCatalogProcessing[];
}>;
/**
 * Rows the peer left out so the snapshot fits one frame (RFC rev.2). Present
 * only when at least one count is non-zero; absent snapshots parse unchanged
 * on hubs that predate the field.
 */
export type FleetCatalogOmitted = Readonly<{
  readonly projects: number;
  readonly sessions: number;
  readonly panes: number;
}>;
/** What the peer-side source hands the publisher: material plus rows it already left out. */
export type FleetCatalogSourceMaterial = FleetCatalogMaterial & Readonly<{
  readonly omitted?: FleetCatalogOmitted;
}>;
export type FleetCatalogSnapshot = FleetCatalogMaterial & Readonly<{
  readonly epoch: string;
  readonly revision: number;
  readonly omitted?: FleetCatalogOmitted;
}>;
type UpsertChange =
  | Readonly<{ readonly op: 'upsert'; readonly entity: 'project'; readonly row: FleetCatalogProject }>
  | Readonly<{ readonly op: 'upsert'; readonly entity: 'session'; readonly row: FleetCatalogSession }>
  | Readonly<{ readonly op: 'upsert'; readonly entity: 'pane'; readonly row: FleetCatalogPane }>
  | Readonly<{ readonly op: 'upsert'; readonly entity: 'processing'; readonly row: FleetCatalogProcessing }>;
type RemoveChange =
  | Readonly<{ readonly op: 'remove'; readonly entity: 'project'; readonly row: FleetCatalogProject }>
  | Readonly<{ readonly op: 'remove'; readonly entity: 'session'; readonly row: FleetCatalogSession }>
  | Readonly<{ readonly op: 'remove'; readonly entity: 'pane'; readonly row: FleetCatalogPane }>
  | Readonly<{ readonly op: 'remove'; readonly entity: 'processing'; readonly row: FleetCatalogProcessing }>;
export type FleetCatalogChange = UpsertChange | RemoveChange;
export type FleetCatalogDelta = Readonly<{
  readonly epoch: string;
  readonly prevRevision: number;
  readonly revision: number;
  readonly host?: FleetCatalogHost;
  readonly changes: readonly FleetCatalogChange[];
  readonly health: FleetCatalogHealth;
}>;
export type FleetCatalogApplyResult = Readonly<{ readonly kind: 'applied' | 'idempotent' | 'resync_required' | 'stale' }>;
export type FleetWriteAdmission = Readonly<{ readonly ok: true }> | Readonly<{ readonly ok: false; readonly error: Extract<FleetErrorCode, 'HOST_NOT_FOUND' | 'HOST_OFFLINE' | 'HOST_SYNCING' | 'HOST_REVOKED' | 'HOST_INCOMPATIBLE'> }>;
export type HostQualifiedRow<T> = Readonly<{ readonly hostId: string; readonly key: string; readonly row: T }>;
export type FleetCatalogRows = Readonly<{
  readonly projects: readonly HostQualifiedRow<FleetCatalogProject>[];
  readonly sessions: readonly HostQualifiedRow<FleetCatalogSession>[];
  readonly panes: readonly HostQualifiedRow<FleetCatalogPane>[];
  readonly processing: readonly HostQualifiedRow<FleetCatalogProcessing>[];
}>;
