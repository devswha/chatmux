/**
 * Browser transport boundary for fleet host availability and catalog material.
 *
 * The hub pushes four frame shapes over the existing browser websocket and
 * answers the same host roster over REST. Both are untrusted input, so they are
 * parsed here exactly once into a typed frame; everything downstream receives
 * typed values and never re-inspects the wire shape.
 *
 * A frame that fails to parse is dropped whole. Partially applying one would let
 * a malformed peer payload delete another host's rows, which is precisely the
 * cross-host confusion the fleet contract forbids.
 */

import {
  type FleetPeerDescriptor,
  parseFleetPeerDescriptor,
} from '../../../shared/fleet';
import { parseHostId } from '../references';

import {
  type FleetHostPaneRow,
  type FleetHostProjectRow,
  type FleetHostRowSet,
  type FleetHostSessionRow,
  parseHostPaneRow,
  parseHostProjectRow,
  parseHostSessionRow,
} from './hostRows';

export const FLEET_HOSTS_ENDPOINT = '/api/fleet/hosts';
export const FLEET_SUBSCRIBE_MESSAGE = 'fleet.subscribe';
export const FLEET_RESYNC_MESSAGE = 'fleet.resync';

export type FleetHostRoster = {
  readonly localHostId: string | null;
  readonly hosts: readonly FleetPeerDescriptor[];
};

export type FleetHostChange =
  | { readonly op: 'upsert'; readonly entity: 'project'; readonly row: FleetHostProjectRow }
  | { readonly op: 'upsert'; readonly entity: 'session'; readonly row: FleetHostSessionRow }
  | { readonly op: 'upsert'; readonly entity: 'pane'; readonly row: FleetHostPaneRow }
  | { readonly op: 'remove'; readonly entity: 'project'; readonly localId: string }
  | { readonly op: 'remove'; readonly entity: 'session'; readonly localId: string }
  | { readonly op: 'remove'; readonly entity: 'pane'; readonly row: FleetHostPaneRow };

export type FleetHostFrame =
  | { readonly kind: 'roster' } & FleetHostRoster
  | { readonly kind: 'host-state'; readonly host: FleetPeerDescriptor }
  | {
    readonly kind: 'snapshot';
    readonly hostId: string;
    readonly epoch: string;
    readonly revision: number;
    readonly rows: FleetHostRowSet;
  }
  | {
    readonly kind: 'delta';
    readonly hostId: string;
    readonly epoch: string;
    readonly prevRevision: number;
    readonly revision: number;
    readonly changes: readonly FleetHostChange[];
  };

const MAX_TEXT_LENGTH = 256;

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_TEXT_LENGTH
    ? value
    : null;
}

function revision(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** A descriptor the shared contract rejects is not a host this browser knows. */
function descriptor(value: unknown): FleetPeerDescriptor | null {
  try {
    return parseFleetPeerDescriptor(value);
  } catch {
    return null;
  }
}

export function parseHostRoster(body: unknown): FleetHostRoster | null {
  const outer = record(body);
  if (outer === null) return null;
  const payload = record(outer.data) ?? outer;
  if (!Array.isArray(payload.hosts)) return null;
  const hosts: FleetPeerDescriptor[] = [];
  for (const candidate of payload.hosts) {
    const host = descriptor(candidate);
    // One malformed descriptor cannot be silently skipped: the roster is
    // authoritative for which hosts exist, and a partial roster would drop a
    // real host's rows.
    if (host === null) return null;
    hosts.push(host);
  }
  if (new Set(hosts.map((host) => host.hostId)).size !== hosts.length) return null;
  return { localHostId: parseHostId(payload.localHostId), hosts };
}

function rowSet(payload: Readonly<Record<string, unknown>>): FleetHostRowSet | null {
  if (
    !Array.isArray(payload.projects)
    || !Array.isArray(payload.sessions)
    || !Array.isArray(payload.panes)
  ) return null;
  const projects = payload.projects.map(parseHostProjectRow);
  const sessions = payload.sessions.map(parseHostSessionRow);
  const panes = payload.panes.map(parseHostPaneRow);
  return projects.includes(null) || sessions.includes(null) || panes.includes(null)
    ? null
    : {
      projects: projects as FleetHostProjectRow[],
      sessions: sessions as FleetHostSessionRow[],
      panes: panes as FleetHostPaneRow[],
    };
}

function change(value: unknown): FleetHostChange | null {
  const payload = record(value);
  if (payload === null) return null;
  const removal = payload.op === 'remove';
  if (!removal && payload.op !== 'upsert') return null;
  switch (payload.entity) {
    case 'project': {
      const row = parseHostProjectRow(payload.row);
      if (row === null) return null;
      return removal
        ? { op: 'remove', entity: 'project', localId: row.localId }
        : { op: 'upsert', entity: 'project', row };
    }
    case 'session': {
      const row = parseHostSessionRow(payload.row);
      if (row === null) return null;
      return removal
        ? { op: 'remove', entity: 'session', localId: row.localId }
        : { op: 'upsert', entity: 'session', row };
    }
    case 'pane': {
      const row = parseHostPaneRow(payload.row);
      if (row === null) return null;
      return removal ? { op: 'remove', entity: 'pane', row } : { op: 'upsert', entity: 'pane', row };
    }
    default:
      return null;
  }
}

export function parseHostFrame(value: unknown): FleetHostFrame | null {
  const payload = record(value);
  if (payload === null) return null;
  switch (payload.kind) {
    case 'fleet.hosts': {
      const roster = parseHostRoster(payload);
      return roster === null ? null : { kind: 'roster', ...roster };
    }
    case 'fleet.host_state': {
      const host = descriptor(payload.host);
      return host === null ? null : { kind: 'host-state', host };
    }
    case 'fleet.catalog.snapshot': {
      const hostId = parseHostId(payload.hostId);
      const epoch = text(payload.epoch);
      const value_ = revision(payload.revision);
      const rows = rowSet(payload);
      return hostId === null || epoch === null || value_ === null || rows === null
        ? null
        : { kind: 'snapshot', hostId, epoch, revision: value_, rows };
    }
    case 'fleet.catalog.delta': {
      const hostId = parseHostId(payload.hostId);
      const epoch = text(payload.epoch);
      const prevRevision = revision(payload.prevRevision);
      const next = revision(payload.revision);
      if (hostId === null || epoch === null || prevRevision === null || next === null) return null;
      if (!Array.isArray(payload.changes)) return null;
      const changes = payload.changes.map(change);
      return changes.includes(null)
        ? null
        : {
          kind: 'delta',
          hostId,
          epoch,
          prevRevision,
          revision: next,
          changes: changes as FleetHostChange[],
        };
    }
    default:
      return null;
  }
}
