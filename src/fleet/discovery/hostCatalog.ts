/**
 * Per-host catalog state for the browser.
 *
 * One entry per host, each with its own epoch, revision, rows and sync state.
 * That isolation is the point: a peer that gaps, floods, goes offline or is
 * removed may only ever change its own entry, so a single failing peer can
 * never blank another host's rows or its pending destructive target.
 *
 * Rows are display material. When a host stops being authoritative it keeps its
 * last rows and reports `syncing`/`offline` instead — a visibly stale row with
 * every action disabled is honest, while an emptied group would read as "this
 * machine has no sessions".
 */

import type { FleetPeerDescriptor } from '../../../shared/fleet';

import type { FleetHostFrame } from './hostFrames';
import {
  EMPTY_HOST_ROW_SET,
  type FleetHostPaneRow,
  type FleetHostProjectRow,
  type FleetHostRowSet,
  type FleetHostSessionRow,
  paneRowKey,
} from './hostRows';

/** Rows accepted per host per entity before that host is marked truncated. */
export const MAX_HOST_ROWS_PER_ENTITY = 500;

export type HostSyncState = 'synced' | 'syncing';

export type FleetHostEntry = {
  readonly descriptor: FleetPeerDescriptor;
  readonly sync: HostSyncState;
  readonly epoch: string | null;
  readonly revision: number;
  readonly rows: FleetHostRowSet;
  readonly truncated: boolean;
};

export type FleetHostCatalog = {
  readonly localHostId: string | null;
  readonly hosts: ReadonlyMap<string, FleetHostEntry>;
};

export type HostFrameOutcome = {
  readonly catalog: FleetHostCatalog;
  /** Host whose stream gapped and needs a full snapshot, or null. */
  readonly resyncHostId: string | null;
};

export const EMPTY_FLEET_HOST_CATALOG: FleetHostCatalog = {
  localHostId: null,
  hosts: new Map(),
};

function unchanged(catalog: FleetHostCatalog): HostFrameOutcome {
  return { catalog, resyncHostId: null };
}

function withEntry(
  catalog: FleetHostCatalog,
  hostId: string,
  entry: FleetHostEntry,
): FleetHostCatalog {
  const hosts = new Map(catalog.hosts);
  hosts.set(hostId, entry);
  return { localHostId: catalog.localHostId, hosts };
}

function capped<T>(rows: readonly T[]): { readonly rows: readonly T[]; readonly truncated: boolean } {
  return rows.length <= MAX_HOST_ROWS_PER_ENTITY
    ? { rows, truncated: false }
    : { rows: rows.slice(0, MAX_HOST_ROWS_PER_ENTITY), truncated: true };
}

function cappedRowSet(rows: FleetHostRowSet): { readonly rows: FleetHostRowSet; readonly truncated: boolean } {
  const projects = capped(rows.projects);
  const sessions = capped(rows.sessions);
  const panes = capped(rows.panes);
  return {
    rows: { projects: projects.rows, sessions: sessions.rows, panes: panes.rows },
    truncated: projects.truncated || sessions.truncated || panes.truncated,
  };
}

function applyRoster(catalog: FleetHostCatalog, frame: FleetHostFrame & { readonly kind: 'roster' }): HostFrameOutcome {
  const hosts = new Map<string, FleetHostEntry>();
  for (const descriptor of frame.hosts) {
    const existing = catalog.hosts.get(descriptor.hostId);
    hosts.set(descriptor.hostId, existing === undefined
      ? { descriptor, sync: 'syncing', epoch: null, revision: 0, rows: EMPTY_HOST_ROW_SET, truncated: false }
      : { ...existing, descriptor });
  }
  return { catalog: { localHostId: frame.localHostId, hosts }, resyncHostId: null };
}

function upsertProject(
  rows: readonly FleetHostProjectRow[],
  row: FleetHostProjectRow,
): readonly FleetHostProjectRow[] {
  const index = rows.findIndex((candidate) => candidate.localId === row.localId);
  return index === -1
    ? [...rows, row]
    : rows.map((candidate, position) => (position === index ? row : candidate));
}

function upsertSession(
  rows: readonly FleetHostSessionRow[],
  row: FleetHostSessionRow,
): readonly FleetHostSessionRow[] {
  const index = rows.findIndex((candidate) => candidate.localId === row.localId);
  return index === -1
    ? [...rows, row]
    : rows.map((candidate, position) => (position === index ? row : candidate));
}

function upsertPane(
  hostId: string,
  rows: readonly FleetHostPaneRow[],
  row: FleetHostPaneRow,
): readonly FleetHostPaneRow[] {
  const key = paneRowKey(hostId, row);
  const index = rows.findIndex((candidate) => paneRowKey(hostId, candidate) === key);
  return index === -1
    ? [...rows, row]
    : rows.map((candidate, position) => (position === index ? row : candidate));
}

function applyChanges(
  hostId: string,
  rows: FleetHostRowSet,
  frame: FleetHostFrame & { readonly kind: 'delta' },
): FleetHostRowSet {
  let next = rows;
  for (const change of frame.changes) {
    switch (change.entity) {
      case 'project':
        next = {
          ...next,
          projects: change.op === 'upsert'
            ? upsertProject(next.projects, change.row)
            : next.projects.filter((row) => row.localId !== change.localId),
        };
        break;
      case 'session':
        next = {
          ...next,
          sessions: change.op === 'upsert'
            ? upsertSession(next.sessions, change.row)
            : next.sessions.filter((row) => row.localId !== change.localId),
        };
        break;
      case 'pane': {
        const key = paneRowKey(hostId, change.row);
        next = {
          ...next,
          panes: change.op === 'upsert'
            ? upsertPane(hostId, next.panes, change.row)
            : next.panes.filter((row) => paneRowKey(hostId, row) !== key),
        };
        break;
      }
      default:
        break;
    }
  }
  return next;
}

/**
 * Applies one parsed frame. The returned catalog is a new value only when the
 * frame changed something, so React can compare by identity and a duplicate
 * frame cannot re-render every host group.
 */
export function applyHostFrame(catalog: FleetHostCatalog, frame: FleetHostFrame): HostFrameOutcome {
  switch (frame.kind) {
    case 'roster':
      return applyRoster(catalog, frame);
    case 'host-state': {
      const entry = catalog.hosts.get(frame.host.hostId);
      // A host the roster does not list is not a host: inventing one here would
      // let an unenrolled installation appear in the sidebar.
      return entry === undefined
        ? unchanged(catalog)
        : unchanged(withEntry(catalog, frame.host.hostId, { ...entry, descriptor: frame.host }));
    }
    case 'snapshot': {
      const entry = catalog.hosts.get(frame.hostId);
      if (entry === undefined) return unchanged(catalog);
      const { rows, truncated } = cappedRowSet(frame.rows);
      return unchanged(withEntry(catalog, frame.hostId, {
        ...entry,
        sync: 'synced',
        epoch: frame.epoch,
        revision: frame.revision,
        rows,
        truncated,
      }));
    }
    case 'delta': {
      const entry = catalog.hosts.get(frame.hostId);
      if (entry === undefined) return unchanged(catalog);
      if (frame.epoch === entry.epoch && frame.revision === entry.revision) {
        // Already applied: the hub replays the last delta after a reconnect.
        return unchanged(catalog);
      }
      if (frame.epoch !== entry.epoch || frame.prevRevision !== entry.revision) {
        return {
          catalog: withEntry(catalog, frame.hostId, { ...entry, sync: 'syncing' }),
          resyncHostId: frame.hostId,
        };
      }
      const { rows, truncated } = cappedRowSet(applyChanges(frame.hostId, entry.rows, frame));
      return unchanged(withEntry(catalog, frame.hostId, {
        ...entry,
        sync: 'synced',
        revision: frame.revision,
        rows,
        truncated,
      }));
    }
    default:
      return unchanged(catalog);
  }
}
