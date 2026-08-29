import assert from 'node:assert/strict';
import test from 'node:test';

import type { FleetCapability, FleetOperation } from '../../../../shared/fleet.js';
import type { HubPeerStatus } from '../hub/connection/types.js';
import { FleetHostRouter, FleetHostRoutingError, type FleetHostClients } from '../routing/host-router.js';

const LOCAL = '11111111-1111-4111-8111-111111111111';
const REMOTE = '22222222-2222-4222-8222-222222222222';
const clients: FleetHostClients = { reads: { marker: 'reads' }, mutations: { marker: 'mutations' }, terminals: { marker: 'terminals' } };

function peer(state: HubPeerStatus['state'] = 'online', capabilities: readonly FleetCapability[] = ['session.read']): HubPeerStatus {
  return { peerId: REMOTE, state, protocolVersion: 'fleet/1', capabilities, peerProcessEpoch: 'peer-process', generation: 7, lastHeartbeatAtMs: 1 };
}

function request(hostId: string | undefined, owner = true, operation: FleetOperation = 'session.history') {
  return { hostId, operation, principal: { id: 'principal-1', owner } } as const;
}

test('Given missing or exact local host, when routed, then current services are selected without peer lookup', () => {
  // Given
  let lookups = 0;
  const router = new FleetHostRouter({ localHostId: LOCAL, clients, status: () => { lookups += 1; return peer(); } });

  // When
  const legacy = router.route(request(undefined, false));
  const qualified = router.route(request(LOCAL, false));

  // Then
  assert.deepEqual([legacy.kind, qualified.kind], ['local', 'local']);
  assert.equal(lookups, 0);
});

test('Given an owner and one online synchronized capable peer, when routed, then that exact peer client is selected once', () => {
  // Given
  const lookedUp: string[] = [];
  const router = new FleetHostRouter({ localHostId: LOCAL, clients, status: (hostId) => { lookedUp.push(hostId); return peer(); } });

  // When
  const result = router.route(request(REMOTE));

  // Then
  assert.equal(result.kind, 'remote');
  if (result.kind === 'remote') assert.equal(result.clients, clients);
  assert.deepEqual(lookedUp, [REMOTE]);
});

test('Given an ordinary user, when a remote host is requested, then denial precedes peer metadata lookup', () => {
  // Given
  let lookups = 0;
  const router = new FleetHostRouter({ localHostId: LOCAL, clients, status: () => { lookups += 1; return peer(); } });

  // When / Then
  assert.throws(() => router.route(request(REMOTE, false)), (error) => error instanceof FleetHostRoutingError && error.statusCode === 403 && error.code === 'FLEET_UNAUTHORIZED');
  assert.equal(lookups, 0);
});

test('Given unknown, revoked, or unavailable peers, when routed, then explicit status is returned without fallback', () => {
  const cases = [
    { status: undefined, code: 'HOST_NOT_FOUND', http: 404 },
    { status: peer('revoked'), code: 'HOST_REVOKED', http: 410 },
    { status: peer('offline'), code: 'HOST_OFFLINE', http: 503 },
    { status: peer('syncing'), code: 'HOST_SYNCING', http: 503 },
    { status: peer('connecting'), code: 'HOST_SYNCING', http: 503 },
    { status: peer('degraded'), code: 'HOST_OFFLINE', http: 503 },
    { status: peer('incompatible'), code: 'HOST_INCOMPATIBLE', http: 503 },
  ] as const;
  for (const scenario of cases) {
    const router = new FleetHostRouter({ localHostId: LOCAL, clients, status: () => scenario.status });
    assert.throws(() => router.route(request(REMOTE)), (error) => error instanceof FleetHostRoutingError && error.statusCode === scenario.http && error.code === scenario.code);
  }
});

test('Given a synchronized peer lacking the operation capability, when routed, then no fleet call is admitted', () => {
  const router = new FleetHostRouter({ localHostId: LOCAL, clients, status: () => peer('online', ['pane.read']) });
  assert.throws(() => router.route(request(REMOTE)), (error) => error instanceof FleetHostRoutingError && error.statusCode === 422 && error.code === 'FLEET_CAPABILITY_UNAVAILABLE');
});

test('Given every session-bearing family, when routed, then read, mutation, and terminal capabilities are admitted explicitly', () => {
  const cases = [
    { capability: 'session.read', operations: ['session.read', 'session.history', 'session.search'] },
    { capability: 'chat.control', operations: ['chat.send', 'chat.abort'] },
    { capability: 'prompt.respond', operations: ['prompt.read', 'prompt.respond', 'approval.read', 'approval.respond'] },
    { capability: 'pane.read', operations: ['pane.capture'] },
    { capability: 'terminal.attach', operations: ['pane.attach'] },
    { capability: 'terminal.input', operations: ['pane.input', 'pane.resize', 'pane.interrupt', 'pane.escape'] },
    { capability: 'session.spawn', operations: ['session.spawn'] },
    { capability: 'session.terminate', operations: ['process.terminate', 'pane.terminate', 'session.terminate'] },
  ] as const;
  for (const scenario of cases) {
    const router = new FleetHostRouter({ localHostId: LOCAL, clients, status: () => peer('online', [scenario.capability]) });
    for (const operation of scenario.operations) assert.equal(router.route(request(REMOTE, true, operation)).kind, 'remote');
  }
});
