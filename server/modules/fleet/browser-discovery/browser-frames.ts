import {
  FLEET_PROTOCOL_VERSION,
  type FleetCapability,
  type FleetPeerDescriptor,
} from '../../../../shared/fleet.js';
import type {
  FleetCatalogChange,
  FleetCatalogDelta,
  FleetCatalogSnapshot,
} from '../catalog/types.js';

export type BrowserFleetCommand =
  | Readonly<{ readonly type: 'fleet.subscribe'; readonly protocolVersion: typeof FLEET_PROTOCOL_VERSION }>
  | Readonly<{ readonly type: 'fleet.resync'; readonly hostId: string; readonly reason: 'gap' }>;

export type BrowserLocalDescriptor = Readonly<{
  readonly hostId: string;
  readonly displayLabel: string;
  readonly capabilities: readonly FleetCapability[];
}>;

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function assertNever(value: never): never {
  throw new TypeError(`unsupported browser catalog change: ${String(value)}`);
}

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null;
}

function exact(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

export function parseBrowserFleetCommand(value: unknown): BrowserFleetCommand | null {
  const input = record(value);
  if (input === null) return null;
  switch (input.type) {
    case 'fleet.subscribe':
      return exact(input, ['type', 'protocolVersion']) && input.protocolVersion === FLEET_PROTOCOL_VERSION
        ? { type: input.type, protocolVersion: input.protocolVersion }
        : null;
    case 'fleet.resync':
      return exact(input, ['type', 'hostId', 'reason'])
        && typeof input.hostId === 'string'
        && UUID_V4.test(input.hostId)
        && input.reason === 'gap'
        ? { type: input.type, hostId: input.hostId, reason: input.reason }
        : null;
    default:
      return null;
  }
}

export function rosterFrame(localHostId: string, hosts: readonly FleetPeerDescriptor[]) {
  return { kind: 'fleet.hosts', localHostId, hosts } as const;
}

export function stateFrame(host: FleetPeerDescriptor) {
  return { kind: 'fleet.host_state', host } as const;
}

function project(row: FleetCatalogSnapshot['projects'][number]) {
  return { localId: row.localId, displayName: row.displayName } as const;
}

function pane(row: FleetCatalogSnapshot['panes'][number]) {
  return {
    localId: row.localId,
    lane: row.lane,
    tmuxName: row.tmuxName,
    tmux: row.tmux,
    process: row.process,
    kind: row.kind,
    providerSessionId: row.providerSessionId,
    activity: row.activity,
    presence: row.presence,
  } as const;
}

export function snapshotFrame(hostId: string, snapshot: FleetCatalogSnapshot) {
  return {
    kind: 'fleet.catalog.snapshot',
    hostId,
    epoch: snapshot.epoch,
    revision: snapshot.revision,
    projects: snapshot.projects.map(project),
    sessions: snapshot.sessions,
    panes: snapshot.panes.map(pane),
  } as const;
}

function browserChange(change: FleetCatalogChange) {
  switch (change.entity) {
    case 'project':
      return change.op === 'remove'
        ? { op: change.op, entity: change.entity, row: project(change.row) }
        : { op: change.op, entity: change.entity, row: project(change.row) };
    case 'session':
      return { op: change.op, entity: change.entity, row: change.row };
    case 'pane':
      return { op: change.op, entity: change.entity, row: pane(change.row) };
    case 'processing':
      return null;
    default:
      return assertNever(change);
  }
}

export function deltaFrame(hostId: string, delta: FleetCatalogDelta) {
  return {
    kind: 'fleet.catalog.delta',
    hostId,
    epoch: delta.epoch,
    prevRevision: delta.prevRevision,
    revision: delta.revision,
    changes: delta.changes.map(browserChange).filter((change) => change !== null),
  } as const;
}
