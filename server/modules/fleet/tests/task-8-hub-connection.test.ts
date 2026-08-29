import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import test from 'node:test';

import type { FleetCapability } from '../../../../shared/fleet.js';
import { createFleetHello, createFleetProof, negotiateFleetChallenge, type FleetIdentitySigner } from '../protocol/auth.js';
import { decodeFleetFrame, encodeFleetFrame } from '../protocol/codec.js';
import { reconnectDelayMs } from '../hub/connection/backoff.js';
import { HubPeerConnection } from '../hub/connection/peer-connection.js';
import type { HubConnectionScheduler, HubPeerRecord, HubPeerSocket, HubPeerStatus } from '../hub/connection/types.js';

class Clock implements HubConnectionScheduler {
  nowMs = 1;
  private sequence = 0;
  private readonly tasks = new Map<number, Readonly<{ atMs: number; callback: () => void }>>();
  schedule(delayMs: number, callback: () => void) {
    this.sequence += 1;
    const id = this.sequence;
    this.tasks.set(id, { atMs: this.nowMs + delayMs, callback });
    return { cancel: () => { this.tasks.delete(id); } };
  }
  advance(durationMs: number): void {
    const target = this.nowMs + durationMs;
    while (true) {
      const next = [...this.tasks.entries()].sort((left, right) => left[1].atMs - right[1].atMs)[0];
      if (next === undefined || next[1].atMs > target) break;
      this.tasks.delete(next[0]); this.nowMs = next[1].atMs; next[1].callback();
    }
    this.nowMs = target;
  }
}

class Socket implements HubPeerSocket {
  readonly sent: string[] = [];
  readonly closes: Readonly<{ code: number; reason: string }>[] = [];
  private openListener: (() => void) | undefined;
  private messageListener: ((raw: Buffer) => void) | undefined;
  private closeListener: (() => void) | undefined;
  onOpen(listener: () => void): void { this.openListener = listener; }
  onMessage(listener: (raw: Buffer) => void): void { this.messageListener = listener; }
  onClose(listener: () => void): void { this.closeListener = listener; }
  onError(): void {}
  send(payload: string): void { this.sent.push(payload); }
  close(code: number, reason: string): void { this.closes.push({ code, reason }); }
  open(): void { this.openListener?.(); }
  receive(payload: string): void { this.messageListener?.(Buffer.from(payload)); }
  disconnect(): void { this.closeListener?.(); }
}

function identity(installationId: string = randomUUID()) {
  const keys = generateKeyPairSync('ed25519');
  const signer: FleetIdentitySigner = { installationId, sign: async (challenge) => sign(null, challenge, keys.privateKey) };
  return { signer, publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() };
}

const peerRecord = (peerId: string, pinnedPublicKey: string): HubPeerRecord => ({
  peerId, url: 'wss://peer.example.test/fleet-ws', transportMode: 'direct-wss', pinnedPublicKey, enrollmentState: 'enrolled',
});

async function authenticate(connection: HubPeerConnection, socket: Socket, peer: ReturnType<typeof identity>, processEpoch = 'peer-epoch', capabilities: readonly FleetCapability[] = ['catalog.read'], generation = 1): Promise<void> {
  socket.open();
  const hubHello = decodeFleetFrame(Buffer.from(socket.sent[0] ?? ''));
  assert.equal(hubHello.kind, 'auth.hello');
  if (hubHello.kind !== 'auth.hello') throw new TypeError('hub hello expected');
  const peerHello = createFleetHello({ role: 'peer', signer: peer.signer, processEpoch, capabilities, transportMode: hubHello.transportMode, connectionId: hubHello.connectionId });
  const negotiation = negotiateFleetChallenge(hubHello, peerHello, peer.signer.installationId);
  const proof = await createFleetProof({ signer: peer.signer, role: 'peer', connectionId: hubHello.connectionId, challenge: negotiation.challenge });
  socket.receive(encodeFleetFrame(peerHello)); await connection.whenIdle();
  socket.receive(encodeFleetFrame(proof)); await connection.whenIdle();
  socket.receive(encodeFleetFrame({ kind: 'heartbeat', connectionGeneration: generation, sentAtMs: 1 })); await connection.whenIdle();
}

test('Given persisted transport metadata, when peers dial, then only exact canonical targets are used without downgrade', () => {
  // Given
  const hub = identity(); const peer = identity(); const clock = new Clock(); const targets: string[] = []; const statuses: HubPeerStatus[] = [];
  const create = (record: HubPeerRecord) => new HubPeerConnection({
    peer: record, local: { signer: hub.signer, processEpoch: 'hub-epoch', capabilities: ['catalog.read'] }, scheduler: clock,
    random: () => 0.5, dial: (target) => { targets.push(target.href); return new Socket(); }, onStatus: (status) => statuses.push(status), onFrame: () => undefined,
  });
  // When
  create(peerRecord(peer.signer.installationId, peer.publicKey)).start();
  create({ ...peerRecord(randomUUID(), peer.publicKey), url: 'ws://127.0.0.1:9443/fleet-ws' }).start();
  create({ ...peerRecord(randomUUID(), peer.publicKey), transportMode: 'ssh-loopback', url: 'ws://192.0.2.1/fleet-ws' }).start();
  create({ ...peerRecord(randomUUID(), peer.publicKey), transportMode: 'ssh-loopback', url: 'ws://[::1]:9443/fleet-ws' }).start();
  // Then
  assert.deepEqual(targets, ['wss://peer.example.test/fleet-ws', 'ws://[::1]:9443/fleet-ws']);
  assert.equal(statuses.filter((status) => status.state === 'offline').length, 2);
});

test('Given pinned mutual auth, when a peer authenticates and heartbeats, then health and epochs fail closed', async () => {
  // Given
  const hub = identity(); const peer = identity(); const clock = new Clock(); const socket = new Socket(); const statuses: HubPeerStatus[] = [];
  const connection = new HubPeerConnection({ peer: peerRecord(peer.signer.installationId, peer.publicKey), local: { signer: hub.signer, processEpoch: 'hub-epoch', capabilities: ['catalog.read'] }, scheduler: clock, random: () => 0.5, dial: () => socket, onStatus: (status) => statuses.push(status), onFrame: () => undefined });
  connection.start();
  // When
  await authenticate(connection, socket, peer); clock.advance(20_000); clock.advance(10_000);
  // Then
  assert.deepEqual(statuses.map((status) => status.state).slice(0, 5), ['connecting', 'syncing', 'online', 'degraded', 'offline']);
  assert.equal(statuses[2]?.generation, 1); assert.equal(statuses[2]?.peerProcessEpoch, 'peer-epoch');
  assert.ok(socket.sent.some((raw) => decodeFleetFrame(Buffer.from(raw)).kind === 'heartbeat'));
});

test('Given reconnect attempts, when jitter is applied, then delays stay bounded and increase exponentially', () => {
  // Given / When
  const low = Array.from({ length: 10 }, (_, attempt) => reconnectDelayMs(attempt, 0));
  const high = Array.from({ length: 10 }, (_, attempt) => reconnectDelayMs(attempt, 1));
  // Then
  assert.ok([...low, ...high].every((delay) => delay >= 1_000 && delay <= 30_000));
  assert.notEqual(low[1], high[1]); assert.equal(high.at(-1), 30_000);
});

test('Given a changed epoch or missing capability, when auth completes, then resync or incompatibility is explicit', async () => {
  // Given
  const hub = identity(); const peer = identity(); const clock = new Clock(); const sockets = [new Socket(), new Socket(), new Socket()]; let dialIndex = 0; const statuses: HubPeerStatus[] = [];
  const connection = new HubPeerConnection({ peer: peerRecord(peer.signer.installationId, peer.publicKey), local: { signer: hub.signer, processEpoch: 'hub-epoch', capabilities: ['catalog.read', 'session.read'] }, requiredCapabilities: ['catalog.read'], scheduler: clock, random: () => 0.5, dial: () => { const socket = sockets[dialIndex]; dialIndex += 1; if (socket === undefined) throw new TypeError('socket missing'); return socket; }, onStatus: (status) => statuses.push(status), onFrame: () => undefined });
  connection.start();
  const first = sockets[0]; const second = sockets[1]; const third = sockets[2];
  if (first === undefined || second === undefined || third === undefined) throw new TypeError('test sockets missing');
  await authenticate(connection, first, peer, 'epoch-one', ['catalog.read'], 1);
  // When
  first.disconnect(); clock.advance(1_000); await authenticate(connection, second, peer, 'epoch-two', ['catalog.read'], 2);
  assert.equal(connection.currentStatus().state, 'syncing');
  connection.markSynchronized(); connection.reconnect(); await authenticate(connection, third, peer, 'epoch-two', ['session.read'], 3);
  // Then
  assert.ok(statuses.some((status) => status.state === 'syncing' && status.peerProcessEpoch === 'epoch-two'));
  assert.equal(statuses.at(-1)?.state, 'incompatible'); assert.equal(second.closes.at(-1)?.reason, 'fleet connection superseded');
});

test('Given pinned identity and superseded generations, when an impostor or old socket emits, then both fail closed', async () => {
  // Given
  const hub = identity(); const peer = identity(); const impostor = identity(peer.signer.installationId); const clock = new Clock();
  const sockets = [new Socket(), new Socket(), new Socket()]; let dialIndex = 0; let acceptedFrames = 0;
  const connection = new HubPeerConnection({
    peer: peerRecord(peer.signer.installationId, peer.publicKey),
    local: { signer: hub.signer, processEpoch: 'hub-epoch', capabilities: ['catalog.read'] }, scheduler: clock, random: () => 0.5,
    dial: () => { const socket = sockets[dialIndex]; dialIndex += 1; if (socket === undefined) throw new TypeError('socket missing'); return socket; },
    onStatus: () => undefined, onFrame: () => { acceptedFrames += 1; },
  });
  const first = sockets[0]; const second = sockets[1]; const third = sockets[2];
  if (first === undefined || second === undefined || third === undefined) throw new TypeError('test sockets missing');
  connection.start(); await authenticate(connection, first, peer, 'peer-epoch', ['catalog.read'], 1);
  connection.reconnect(); await authenticate(connection, second, peer, 'peer-epoch', ['catalog.read'], 2);

  // When
  first.receive(encodeFleetFrame({
    kind: 'event', protocolVersion: 'fleet/1', connectionGeneration: 1, eventId: 'stale-event',
    event: 'host.state', hostId: peer.signer.installationId, body: null,
  }));
  second.receive(encodeFleetFrame({
    kind: 'event', protocolVersion: 'fleet/1', connectionGeneration: 2, eventId: 'current-event',
    event: 'host.state', hostId: peer.signer.installationId, body: null,
  }));
  await connection.whenIdle();
  connection.reconnect(); await authenticate(connection, third, impostor, 'peer-epoch', ['catalog.read'], 3);

  // Then
  assert.equal(acceptedFrames, 1);
  assert.equal(third.closes.at(-1)?.reason, 'fleet authentication rejected');
  assert.equal(connection.currentStatus().state, 'offline');
});
