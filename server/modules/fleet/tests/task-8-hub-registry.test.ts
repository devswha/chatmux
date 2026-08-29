import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { HubPeerConnectionRegistry, type ManagedHubPeerConnection } from '../hub/connection/registry.js';
import type { HubPeerConnectionOptions, HubPeerRecord, HubPeerStatus } from '../hub/connection/types.js';

const offline = (peerId: string): HubPeerStatus => ({
  peerId, state: 'offline', protocolVersion: null, capabilities: [], peerProcessEpoch: null, generation: null, lastHeartbeatAtMs: null,
});

class Managed implements ManagedHubPeerConnection {
  starts = 0;
  stops: string[] = [];
  reconnects = 0;
  synchronizations = 0;
  constructor(private readonly options: HubPeerConnectionOptions) {}
  start(): void { this.starts += 1; }
  stop(state: 'offline' | 'revoked' = 'offline'): void { this.stops.push(state); }
  reconnect(): void { this.reconnects += 1; }
  markSynchronized(): void { this.synchronizations += 1; }
  currentStatus(): HubPeerStatus { return offline(this.options.peer.peerId); }
}

function record(peerId = randomUUID()): HubPeerRecord {
  return { peerId, url: `wss://${peerId}.example.test/fleet-ws`, transportMode: 'direct-wss', pinnedPublicKey: `key-${peerId}`, enrollmentState: 'enrolled' };
}

function registry(records: { value: readonly HubPeerRecord[] }, created: Managed[]) {
  return new HubPeerConnectionRegistry({
    peers: { list: () => records.value },
    local: { signer: { installationId: randomUUID(), sign: async () => new Uint8Array(64) }, processEpoch: 'hub', capabilities: ['catalog.read'] },
    scheduler: { nowMs: 1, schedule: () => ({ cancel: () => undefined }) }, random: () => 0.5,
    dial: () => { throw new TypeError('test registry must use managed connections'); },
    recordNegotiation: () => undefined, onFrame: () => undefined,
    createConnection: (options) => { const managed = new Managed(options); created.push(managed); return managed; },
  });
}

test('Given ten persisted peers including a slow peer, when the registry starts, then exactly nine start independently', () => {
  // Given
  const records = { value: Array.from({ length: 10 }, () => record()) }; const created: Managed[] = [];
  const subject = registry(records, created);

  // When
  subject.start();

  // Then
  assert.equal(created.length, 9);
  assert.ok(created.every((connection) => connection.starts === 1));
});

test('Given an active peer, when persistence revokes or changes its route, then the old generation is stopped before replacement', () => {
  // Given
  const first = record(); const records: { value: readonly HubPeerRecord[] } = { value: [first] }; const created: Managed[] = [];
  const subject = registry(records, created); subject.start();
  const active = created[0];
  if (active === undefined) throw new TypeError('managed connection missing');

  // When
  records.value = [{ ...first, enrollmentState: 'revoked' }]; subject.reconcile();
  records.value = [{ ...first, url: `wss://replacement.example.test/fleet-ws` }]; subject.reconcile();

  // Then
  assert.deepEqual(active.stops, ['revoked']);
  assert.equal(created.length, 2);
  assert.equal(created[1]?.starts, 1);
});

test('Given a controller restart, when a new registry starts, then persisted enrolled peers dial again', () => {
  // Given
  const records = { value: [record(), record()] }; const firstCreated: Managed[] = []; const secondCreated: Managed[] = [];
  const first = registry(records, firstCreated); const second = registry(records, secondCreated);

  // When
  first.start(); first.stop(); second.start();

  // Then
  assert.equal(firstCreated.length, 2); assert.ok(firstCreated.every((connection) => connection.stops.includes('offline')));
  assert.equal(secondCreated.length, 2); assert.ok(secondCreated.every((connection) => connection.starts === 1));
});
