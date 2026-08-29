/**
 * Fixtures for the fleet discovery suites: one local host and two remote peers
 * that deliberately collide on every display label and local id, differing only
 * by host id and tmux socket. Every grouping, filtering and clearing assertion
 * is meaningless unless the fixture can produce that collision.
 */

import type { FleetPeerDescriptor, FleetPeerState } from '../../../shared/fleet';

import type { FleetHostPaneRow, FleetHostSessionRow } from './hostRows';

export const LOCAL_HOST_ID = '11111111-1111-4111-8111-111111111111';
export const PEER_A_HOST_ID = '22222222-2222-4222-8222-222222222222';
export const PEER_B_HOST_ID = '33333333-3333-4333-8333-333333333333';

export function peerDescriptor(
  hostId: string,
  displayLabel: string,
  state: FleetPeerState = 'online',
): FleetPeerDescriptor {
  return {
    hostId,
    displayLabel,
    state,
    protocolVersion: 'fleet/1',
    capabilities: ['catalog.read', 'session.read'],
  };
}

export function rosterFrame(hosts: readonly FleetPeerDescriptor[]): Record<string, unknown> {
  return { kind: 'fleet.hosts', localHostId: LOCAL_HOST_ID, hosts };
}

export function sessionRow(
  localId: string,
  summary: string,
  lastActivityMs = 1_700_000_000_000,
): FleetHostSessionRow {
  return { localId, projectLocalId: 'project-omg', provider: 'gjc', summary, lastActivityMs };
}

export function paneRow(
  socketPath: string,
  tmuxName: string,
  presence: 'present' | 'stale' = 'present',
): FleetHostPaneRow {
  return {
    localId: 'idle-gjc:omg',
    lane: 'live',
    tmuxName,
    tmux: { socketPath, sessionId: '$1', windowId: '@1', paneId: '%1' },
    process: { pid: 4242, startedAtMs: 1_700_000_000_000 },
    kind: 'interactive',
    providerSessionId: 'gjc-session',
    activity: 'running',
    presence,
  };
}

export function snapshotFrame(
  hostId: string,
  revision: number,
  rows: {
    readonly sessions?: readonly FleetHostSessionRow[];
    readonly panes?: readonly FleetHostPaneRow[];
  } = {},
): Record<string, unknown> {
  return {
    kind: 'fleet.catalog.snapshot',
    hostId,
    epoch: `epoch-${hostId}`,
    revision,
    projects: [{ localId: 'project-omg', displayName: 'omg' }],
    sessions: rows.sessions ?? [],
    panes: rows.panes ?? [],
  };
}

export function deltaFrame(
  hostId: string,
  revisions: { readonly prevRevision: number; readonly revision: number },
  changes: readonly unknown[],
): Record<string, unknown> {
  return {
    kind: 'fleet.catalog.delta',
    hostId,
    epoch: `epoch-${hostId}`,
    prevRevision: revisions.prevRevision,
    revision: revisions.revision,
    changes,
  };
}
