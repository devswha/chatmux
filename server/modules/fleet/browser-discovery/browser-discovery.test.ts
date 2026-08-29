import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { FLEET_PROTOCOL_VERSION } from '../../../../shared/fleet.js';
import type {
  FleetCatalogHostView,
  FleetCatalogNotification,
} from '../catalog/aggregator.js';
import type { HubPeerStatus } from '../hub/connection/types.js';

import { createFleetBrowserDiscovery } from './browser-discovery.js';

const LOCAL = randomUUID();
const PEER_A = randomUUID();
const PEER_B = randomUUID();

function status(peerId: string, state: HubPeerStatus['state']): HubPeerStatus {
  return {
    peerId,
    state,
    protocolVersion: FLEET_PROTOCOL_VERSION,
    capabilities: ['catalog.read', 'session.read'],
    peerProcessEpoch: `epoch-${peerId}`,
    generation: 1,
    lastHeartbeatAtMs: 1,
  };
}

function snapshot(hostId: string, revision: number): FleetCatalogHostView {
  return {
    generation: 1,
    epoch: `epoch-${hostId}`,
    state: 'online',
    stale: false,
    revision,
    lastDelta: null,
    snapshot: {
      epoch: `epoch-${hostId}`,
      revision,
      host: { hostId, displayLabel: 'studio', capabilities: ['catalog.read'] },
      projects: [{ localId: 'project', path: '/private/path', displayName: 'same', isStarred: false }],
      sessions: [{ localId: 'session', projectLocalId: 'project', provider: 'gjc', summary: 'same', lastActivityMs: 1 }],
      panes: [],
      processing: [],
      health: {
        external: { ok: true, lastOkRevision: revision, consecutiveFailures: 0 },
        live: { ok: true, lastOkRevision: revision, consecutiveFailures: 0 },
      },
    },
  };
}

test('Given an owner browser, when it subscribes, then current hosts and peer snapshots are sent', () => {
  const statuses = [status(PEER_A, 'online'), status(PEER_B, 'offline')];
  const catalogs = new Map<string, FleetCatalogHostView>([
    [PEER_A, snapshot(PEER_A, 2)],
    [PEER_B, snapshot(PEER_B, 3)],
  ]);
  const sent: string[] = [];
  const authority = createFleetBrowserDiscovery({
    local: { hostId: LOCAL, displayLabel: 'controller', capabilities: ['catalog.read'] },
    peers: { list: () => [
      { peerId: PEER_A, displayLabel: 'studio', enrollmentState: 'enrolled' },
      { peerId: PEER_B, displayLabel: 'studio', enrollmentState: 'enrolled' },
    ] },
    registry: {
      listStatuses: () => statuses,
      subscribeStatus: () => () => undefined,
      requestCatalogSnapshot: () => 'requested',
    },
    catalog: {
      host: (hostId) => catalogs.get(hostId),
      subscribe: () => () => undefined,
    },
  });
  const socket = { send: (payload: string, callback: (error?: Error) => void) => { sent.push(payload); callback(); }, close: () => undefined };

  const handled = authority.handle(socket, { type: 'fleet.subscribe', protocolVersion: FLEET_PROTOCOL_VERSION }, true);

  assert.equal(handled, true);
  const frames = sent.map((payload) => JSON.parse(payload) as Readonly<Record<string, unknown>>);
  assert.deepEqual(frames.map((frame) => frame.kind), [
    'fleet.hosts',
    'fleet.host_state',
    'fleet.catalog.snapshot',
    'fleet.host_state',
    'fleet.catalog.snapshot',
  ]);
  const roster = frames[0];
  assert.equal(roster?.localHostId, LOCAL);
  assert.equal(JSON.stringify(roster).includes('/private/path'), false);
  authority.dispose();
});

test('Given an ordinary allowlisted browser, when it subscribes, then no fleet metadata is exposed', () => {
  const sent: string[] = [];
  const authority = createFleetBrowserDiscovery({
    local: { hostId: LOCAL, displayLabel: 'controller', capabilities: [] },
    peers: { list: () => [{ peerId: PEER_A, displayLabel: 'secret-peer', enrollmentState: 'enrolled' }] },
    registry: { listStatuses: () => [status(PEER_A, 'online')], subscribeStatus: () => () => undefined, requestCatalogSnapshot: () => undefined },
    catalog: { host: () => undefined, subscribe: () => () => undefined },
  });
  const socket = { send: (payload: string, callback: (error?: Error) => void) => { sent.push(payload); callback(); }, close: () => undefined };

  authority.handle(socket, { type: 'fleet.subscribe', protocolVersion: FLEET_PROTOCOL_VERSION }, false);

  assert.equal(sent.some((payload) => payload.includes('secret-peer') || payload.includes(PEER_A)), false);
  authority.dispose();
});

test('Given two subscribed peers, when one changes and resync is requested, then only that host is emitted and requested', () => {
  const statusListeners = new Set<(value: HubPeerStatus) => void>();
  const catalogListeners = new Set<(notification: FleetCatalogNotification) => void>();
  const requested: string[] = [];
  const sent: string[] = [];
  const authority = createFleetBrowserDiscovery({
    local: { hostId: LOCAL, displayLabel: 'controller', capabilities: [] },
    peers: { list: () => [
      { peerId: PEER_A, displayLabel: 'studio', enrollmentState: 'enrolled' },
      { peerId: PEER_B, displayLabel: 'studio', enrollmentState: 'enrolled' },
    ] },
    registry: {
      listStatuses: () => [status(PEER_A, 'online'), status(PEER_B, 'online')],
      subscribeStatus: (listener) => { statusListeners.add(listener); return () => statusListeners.delete(listener); },
      requestCatalogSnapshot: (hostId) => { requested.push(hostId); return 'requested'; },
    },
    catalog: {
      host: (hostId) => snapshot(hostId, hostId === PEER_A ? 4 : 8),
      subscribe: (listener) => {
        catalogListeners.add(listener);
        return () => catalogListeners.delete(listener);
      },
    },
  });
  const socket = { send: (payload: string, callback: (error?: Error) => void) => { sent.push(payload); callback(); }, close: () => undefined };
  authority.handle(socket, { type: 'fleet.subscribe', protocolVersion: FLEET_PROTOCOL_VERSION }, true);
  sent.length = 0;

  for (const listener of statusListeners) listener(status(PEER_A, 'offline'));
  for (const listener of catalogListeners) listener({
    hostId: PEER_A,
    kind: 'snapshot',
    snapshot: snapshot(PEER_A, 5).snapshot,
  });
  authority.handle(socket, { type: 'fleet.resync', hostId: PEER_A, reason: 'gap' }, true);

  assert.deepEqual(requested, [PEER_A]);
  assert.equal(sent.some((payload) => payload.includes('fleet.catalog.snapshot')), true);
  assert.equal(sent.every((payload) => !payload.includes(PEER_B)), true);
  authority.close(socket);
  authority.dispose();
  assert.equal(statusListeners.size, 0);
  assert.equal(catalogListeners.size, 0);
});

test('Given one stalled browser, when host state bursts, then only its bounded writer is closed', () => {
  const listeners = new Set<(value: HubPeerStatus) => void>();
  let slowClosed = 0;
  const fastFrames: string[] = [];
  const authority = createFleetBrowserDiscovery({
    local: { hostId: LOCAL, displayLabel: 'controller', capabilities: [] },
    peers: { list: () => [{ peerId: PEER_A, displayLabel: 'studio', enrollmentState: 'enrolled' }] },
    registry: {
      listStatuses: () => [status(PEER_A, 'online')],
      subscribeStatus: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
      requestCatalogSnapshot: () => undefined,
    },
    catalog: { host: () => undefined, subscribe: () => () => undefined },
  });
  const slow = {
    send: (_payload: string, _callback: (error?: Error) => void) => undefined,
    close: () => { slowClosed += 1; },
  };
  const fast = {
    send: (payload: string, callback: (error?: Error) => void) => { fastFrames.push(payload); callback(); },
    close: () => undefined,
  };
  authority.handle(slow, { type: 'fleet.subscribe', protocolVersion: FLEET_PROTOCOL_VERSION }, true);
  authority.handle(fast, { type: 'fleet.subscribe', protocolVersion: FLEET_PROTOCOL_VERSION }, true);
  fastFrames.length = 0;

  for (let index = 0; index < 300; index += 1) {
    for (const listener of listeners) listener(status(PEER_A, index % 2 === 0 ? 'online' : 'degraded'));
  }

  assert.equal(slowClosed, 1);
  assert.equal(fastFrames.length, 300);
  authority.dispose();
});
