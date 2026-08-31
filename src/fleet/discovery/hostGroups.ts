/**
 * View model for the sidebar's host groups.
 *
 * One group per host, local first. The group carries the three facts the sidebar
 * cannot guess: whether the host is currently authoritative (so its actions may
 * be enabled), whether a label is ambiguous across hosts (so the host label must
 * be exposed on the row), and whether an empty group means "nothing is running
 * here" or "this host cannot tell us right now".
 *
 * Zero remote hosts produces zero groups: a single-machine install must render
 * exactly the sidebar it rendered before the fleet existed.
 */

import type { FleetPeerState } from '../../../shared/fleet';
import { type HostQualifiedKey, referenceKey, sessionRef } from '../references';

import type { FleetHostCatalog, FleetHostEntry, HostSyncState } from './hostCatalog';
import { type FleetHostPaneRow, type FleetHostSessionRow, paneRowKey } from './hostRows';

export type HostGroupRowKind = 'session' | 'pane';

export type HostGroupRow = {
  readonly key: HostQualifiedKey;
  readonly kind: HostGroupRowKind;
  readonly localId: string;
  /** Provider used by the local-style row icon and activity treatment. */
  readonly provider: string;
  readonly label: string;
  readonly detail: string;
  /** The row's own evidence is stale, or its host is no longer authoritative. */
  readonly stale: boolean;
  /** This label also exists on another host, so the host label must be shown. */
  readonly duplicateLabel: boolean;
  /** App transcript owned by this row. Null when the pane has no catalogued conversation yet. */
  readonly transcriptLocalId: string | null;
  /** Exact pane display target. Null for transcript-only rows. */
  readonly pane: FleetHostPaneRow | null;
};

export type HostGroupCounts = {
  readonly sessions: number;
  readonly panes: number;
};

export type HostGroupEmptiness = 'populated' | 'empty' | 'unknown';

export type HostGroup = {
  readonly hostId: string;
  readonly isLocal: boolean;
  readonly label: string;
  readonly labelDuplicated: boolean;
  readonly state: FleetPeerState;
  readonly sync: HostSyncState;
  readonly actionsEnabled: boolean;
  readonly availability: 'available' | 'unavailable';
  readonly emptiness: HostGroupEmptiness;
  readonly truncated: boolean;
  readonly counts: HostGroupCounts;
  readonly rows: readonly HostGroupRow[];
};

export type LocalHostSummary = {
  /** Already-translated fallback label for the local machine. */
  readonly label: string;
  /** Labels the local sections are rendering, for cross-host ambiguity checks. */
  readonly rowLabels: readonly string[];
  readonly counts: HostGroupCounts;
};

export type HostGroupsInput = {
  readonly catalog: FleetHostCatalog;
  readonly local: LocalHostSummary;
  /** Host id to show alone, or null for every host. */
  readonly filter: string | null;
};

/** Only a host that is online AND caught up may drive an enabled control. */
export function hostActionsEnabled(state: FleetPeerState, sync: HostSyncState): boolean {
  return state === 'online' && sync === 'synced';
}

export function hostAvailability(
  state: FleetPeerState,
  sync: HostSyncState,
): 'available' | 'unavailable' {
  return hostActionsEnabled(state, sync) ? 'available' : 'unavailable';
}

function paneLabels(entry: FleetHostEntry): readonly string[] {
  return [
    ...entry.rows.panes.map((row) => row.tmuxName),
    ...entry.rows.sessions.map((row) => row.summary || row.localId),
  ];
}

function hostsByLabel(input: HostGroupsInput): ReadonlyMap<string, ReadonlySet<string>> {
  const owners = new Map<string, Set<string>>();
  const add = (label: string, hostId: string) => {
    if (label.length === 0) return;
    const existing = owners.get(label);
    if (existing === undefined) owners.set(label, new Set([hostId]));
    else existing.add(hostId);
  };
  for (const label of input.local.rowLabels) add(label, input.catalog.localHostId ?? '');
  for (const [hostId, entry] of input.catalog.hosts) {
    if (hostId === input.catalog.localHostId) continue;
    for (const label of paneLabels(entry)) add(label, hostId);
  }
  return owners;
}

function paneGroupRow(
  hostId: string,
  row: FleetHostPaneRow,
  context: {
    readonly stale: boolean;
    readonly duplicated: (label: string) => boolean;
    readonly transcriptLocalId: string | null;
    readonly provider: string;
  },
): HostGroupRow {
  return {
    key: paneRowKey(hostId, row),
    kind: 'pane',
    localId: row.providerSessionId ?? row.localId,
    provider: context.provider,
    label: row.tmuxName,
    detail: row.kind,
    stale: context.stale || row.presence === 'stale' || row.process === null,
    duplicateLabel: context.duplicated(row.tmuxName),
    transcriptLocalId: context.transcriptLocalId,
    pane: row,
  };
}

function sessionGroupRow(
  hostId: string,
  row: FleetHostSessionRow,
  context: {
    readonly stale: boolean;
    readonly duplicated: (label: string) => boolean;
    readonly projectName: (localId: string) => string;
  },
): HostGroupRow {
  const label = row.summary || row.localId;
  return {
    key: referenceKey(sessionRef(hostId, row.localId)),
    kind: 'session',
    localId: row.localId,
    provider: row.provider,
    label,
    detail: context.projectName(row.projectLocalId) || row.provider,
    stale: context.stale,
    duplicateLabel: context.duplicated(label),
    transcriptLocalId: row.localId,
    pane: null,
  };
}

function groupRows(
  hostId: string,
  entry: FleetHostEntry,
  context: { readonly stale: boolean; readonly duplicated: (label: string) => boolean },
): readonly HostGroupRow[] {
  const projectName = (localId: string) =>
    entry.rows.projects.find((project) => project.localId === localId)?.displayName ?? '';
  // A pane already represents its session as a live row; listing the session
  // again would double every running conversation.
  const paneSessionIds = new Set(
    entry.rows.panes.map((row) => row.providerSessionId).filter((id): id is string => id !== null),
  );
  const transcriptSessionIds = new Set(entry.rows.sessions.map((row) => row.localId));
  const sessionProviders = new Map(
    entry.rows.sessions.map((row) => [row.localId, row.provider]),
  );
  const panes = [...entry.rows.panes]
    .sort((left, right) => left.tmuxName.localeCompare(right.tmuxName))
    .map((row) => paneGroupRow(hostId, row, {
      ...context,
      transcriptLocalId: row.providerSessionId !== null && transcriptSessionIds.has(row.providerSessionId)
        ? row.providerSessionId
        : null,
      provider: row.providerSessionId === null
        ? row.kind
        : sessionProviders.get(row.providerSessionId) ?? row.kind,
    }));
  const sessions = [...entry.rows.sessions]
    .filter((row) => !paneSessionIds.has(row.localId))
    .sort((left, right) => right.lastActivityMs - left.lastActivityMs)
    .map((row) => sessionGroupRow(hostId, row, { ...context, projectName }));
  return [...panes, ...sessions];
}

function emptinessOf(entry: FleetHostEntry, rowCount: number): HostGroupEmptiness {
  // No snapshot has ever landed, so "no rows" carries no information.
  if (entry.epoch === null) return 'unknown';
  return rowCount === 0 ? 'empty' : 'populated';
}

function buildGroup(
  hostId: string,
  entry: FleetHostEntry,
  input: HostGroupsInput & { readonly owners: ReadonlyMap<string, ReadonlySet<string>> },
): HostGroup {
  const isLocal = hostId === input.catalog.localHostId;
  const state = isLocal ? 'online' : entry.descriptor.state;
  const sync = isLocal ? 'synced' : entry.sync;
  const actionsEnabled = hostActionsEnabled(state, sync);
  const duplicated = (label: string) => (input.owners.get(label)?.size ?? 0) > 1;
  const rows = isLocal
    ? []
    : groupRows(hostId, entry, { stale: !actionsEnabled, duplicated });
  const labels = [...input.catalog.hosts.values()].map((candidate) => candidate.descriptor.displayLabel);
  const label = entry.descriptor.displayLabel;
  return {
    hostId,
    isLocal,
    label: isLocal && label.length === 0 ? input.local.label : label,
    labelDuplicated: labels.filter((candidate) => candidate === label).length > 1,
    state,
    sync,
    actionsEnabled,
    availability: hostAvailability(state, sync),
    emptiness: isLocal ? 'populated' : emptinessOf(entry, rows.length),
    truncated: entry.truncated,
    counts: isLocal
      ? input.local.counts
      : {
        sessions: entry.rows.sessions.length,
        panes: entry.rows.panes.length,
      },
    rows,
  };
}

export function hostGroups(input: HostGroupsInput): readonly HostGroup[] {
  const remoteHostIds = [...input.catalog.hosts.keys()].filter((hostId) => hostId !== input.catalog.localHostId);
  // A single-machine install gets the pre-fleet sidebar, unchanged.
  if (remoteHostIds.length === 0) return [];
  const owners = hostsByLabel(input);
  const groups = [...input.catalog.hosts.entries()]
    .map(([hostId, entry]) => buildGroup(hostId, entry, { ...input, owners }))
    .sort((left, right) => {
      if (left.isLocal !== right.isLocal) return left.isLocal ? -1 : 1;
      const byLabel = left.label.localeCompare(right.label);
      return byLabel === 0 ? left.hostId.localeCompare(right.hostId) : byLabel;
    });
  const filtered = input.filter === null
    ? groups
    : groups.filter((group) => group.hostId === input.filter);
  // A filter that names no known host must not blank the sidebar.
  return filtered.length === 0 ? groups : filtered;
}
