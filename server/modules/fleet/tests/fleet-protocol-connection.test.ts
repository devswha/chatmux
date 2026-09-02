import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import test from 'node:test';

import { parseFleetRequestEnvelope, type FleetRequestEnvelope, type FleetResponseEnvelope } from '../../../../shared/fleet.js';
import {
  createFleetHello,
  createFleetProof,
  FleetChallengeReplayGuard,
  negotiateFleetChallenge,
  type FleetIdentitySigner,
} from '../protocol/auth.js';
import { decodeFleetFrame, encodeFleetFrame, FLEET_MAX_FRAME_BYTES } from '../protocol/codec.js';
import { FleetProtocolConnection } from '../protocol/connection.js';
import type {
  FleetProtocolConnectionOptions,
  FleetProtocolScheduler,
  FleetScheduledTask,
} from '../protocol/connection-types.js';
import { FleetConnectionRegistry, type FleetGenerationStore } from '../protocol/state-machine.js';
import type { FleetWritableTransport } from '../protocol/bounded-writer.js';

class Scheduler implements FleetProtocolScheduler {
  nowMs = 1;
  readonly tasks: { at: number; callback: () => void; active: boolean }[] = [];
  now(): number { return this.nowMs; }
  schedule(delayMs: number, callback: () => void): FleetScheduledTask {
    const task = { at: this.nowMs + delayMs, callback, active: true };
    this.tasks.push(task);
    return { cancel: () => { task.active = false; } };
  }
  advance(ms: number): void {
    this.nowMs += ms;
    for (const task of this.tasks.filter((candidate) => candidate.active && candidate.at <= this.nowMs)) {
      task.active = false;
      task.callback();
    }
  }
}

class GenerationStore implements FleetGenerationStore {
  generation = 0;
  async claimNext(): Promise<number> { this.generation += 1; return this.generation; }
}

class Transport implements FleetWritableTransport {
  readonly sent: string[] = [];
  readonly closes: Readonly<{ code: number; reason: string }>[] = [];
  readonly waiters: { count: number; resolve: () => void }[] = [];
  blocked = false;
  send(payload: string, callback: (error?: Error) => void): void {
    this.sent.push(payload);
    for (const waiter of this.waiters.filter((candidate) => candidate.count <= this.sent.length)) waiter.resolve();
    if (!this.blocked) callback();
  }
  close(code: number, reason: string): void { this.closes.push({ code, reason }); }
  waitForCount(count: number): Promise<void> {
    if (this.sent.length >= count) return Promise.resolve();
    return new Promise<void>((resolve) => { this.waiters.push({ count, resolve }); });
  }
}

function identity() {
  const keys = generateKeyPairSync('ed25519');
  const signer: FleetIdentitySigner = {
    installationId: randomUUID(),
    sign: async (challenge) => sign(null, challenge, keys.privateKey),
  };
  return { signer, publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() };
}

function successfulResponse(request: FleetRequestEnvelope): FleetResponseEnvelope {
  return {
    kind: 'response', protocolVersion: request.protocolVersion, connectionGeneration: request.connectionGeneration,
    requestId: request.requestId, target: request.target, status: 'success', sideEffect: 'none', body: null,
  };
}

function request(generation: number, body: null | Readonly<Record<string, string>> = null, operation: 'catalog.snapshot' | 'chat.send' = 'catalog.snapshot') {
  const target = operation === 'catalog.snapshot'
    ? { kind: 'host', hostId: '123e4567-e89b-42d3-a456-426614174000' }
    : { kind: 'session', hostId: '123e4567-e89b-42d3-a456-426614174000', localId: 'session-1' };
  return parseFleetRequestEnvelope({
    kind: 'request', protocolVersion: 'fleet/1', connectionGeneration: generation,
    requestId: 'request-1', operation, target, body,
  });
}

function fixture(overrides: Partial<FleetProtocolConnectionOptions> = {}, suppliedHub?: ReturnType<typeof identity>, capabilities: FleetProtocolConnectionOptions['local']['capabilities'] = ['catalog.read']) {
  const hub = suppliedHub ?? identity();
  const peer = identity();
  const scheduler = new Scheduler();
  const transport = new Transport();
  const registry = new FleetConnectionRegistry(new GenerationStore());
  const activeTransport = overrides.transport instanceof Transport ? overrides.transport : transport;
  let dispatchCount = 0;
  const options: FleetProtocolConnectionOptions = {
    local: { role: 'peer', signer: peer.signer, processEpoch: 'peer-epoch', capabilities, transportMode: 'direct-wss' },
    trust: { find: async (installationId) => ({ installationId, pinnedPublicKey: hub.publicKey, state: 'active' }) },
    replayGuard: new FleetChallengeReplayGuard(), registry, transport: activeTransport, scheduler,
    dispatch: async (incoming) => { dispatchCount += 1; return successfulResponse(incoming); },
    ...overrides,
  };
  return { hub, peer, scheduler, transport: activeTransport, registry, options, connection: new FleetProtocolConnection(options), dispatchCount: () => dispatchCount };
}

async function authenticate(subject: ReturnType<typeof fixture>, connectionId = randomUUID(), capabilities: FleetProtocolConnectionOptions['local']['capabilities'] = ['catalog.read']): Promise<void> {
  const hello = createFleetHello({
    role: 'hub', signer: subject.hub.signer, processEpoch: 'hub-epoch', capabilities,
    transportMode: 'direct-wss', connectionId,
  });
  await subject.connection.receive(Buffer.from(encodeFleetFrame(hello)));
  const peerHello = decodeFleetFrame(Buffer.from(subject.transport.sent[0] ?? ''));
  if (peerHello.kind !== 'auth.hello') throw new TypeError('peer hello missing');
  const negotiation = negotiateFleetChallenge(hello, peerHello, subject.peer.signer.installationId);
  const proof = await createFleetProof({ signer: subject.hub.signer, role: 'hub', connectionId, challenge: negotiation.challenge });
  await subject.connection.receive(Buffer.from(encodeFleetFrame(proof)));
}

test('Given an unauthenticated connection, when five seconds pass, then it closes with a redacted error code', () => {
  const errors: string[] = [];
  const subject = fixture({ onError: (code) => { errors.push(code); } });

  subject.scheduler.advance(5_000);

  assert.deepEqual(subject.transport.closes, [{ code: 4003, reason: 'fleet authentication rejected' }]);
  assert.deepEqual(errors, ['AUTH_DEADLINE_EXCEEDED']);
});

test('Given a wrong pinned key or replayed challenge, when proof arrives, then auth fails before dispatch', async () => {
  const wrong = identity();
  const wrongKey = fixture({ trust: { find: async (installationId) => ({ installationId, pinnedPublicKey: wrong.publicKey, state: 'active' }) } });
  await authenticate(wrongKey);
  assert.equal(wrongKey.transport.closes[0]?.reason, 'fleet authentication rejected');
  assert.equal(wrongKey.dispatchCount(), 0);

  const replay = fixture();
  const connectionId = randomUUID();
  const hello = createFleetHello({ role: 'hub', signer: replay.hub.signer, processEpoch: 'hub-epoch', capabilities: ['catalog.read'], transportMode: 'direct-wss', connectionId });
  await replay.connection.receive(Buffer.from(encodeFleetFrame(hello)));
  const peerHello = decodeFleetFrame(Buffer.from(replay.transport.sent[0] ?? ''));
  if (peerHello.kind !== 'auth.hello') throw new TypeError('peer hello missing');
  const negotiation = negotiateFleetChallenge(hello, peerHello, replay.peer.signer.installationId);
  replay.options.replayGuard.reserve(negotiation.challengeId);
  const proof = await createFleetProof({ signer: replay.hub.signer, role: 'hub', connectionId, challenge: negotiation.challenge });
  await replay.connection.receive(Buffer.from(encodeFleetFrame(proof)));
  assert.equal(replay.transport.closes[0]?.reason, 'fleet authentication rejected');
  assert.equal(replay.dispatchCount(), 0);
});

test('Given authenticated generations, when superseded or lease-expired frames arrive, then dispatch remains zero', async () => {
  const sharedStore = new GenerationStore();
  const registry = new FleetConnectionRegistry(sharedStore);
  const first = fixture({ registry });
  const second = fixture({ registry, trust: first.options.trust }, first.hub);
  await authenticate(first);
  await authenticate(second);
  assert.equal(first.transport.closes[0]?.reason, 'fleet connection superseded');
  await first.connection.receive(Buffer.from(encodeFleetFrame(request(1))));
  assert.equal(first.dispatchCount(), 0);

  second.scheduler.advance(30_000);
  assert.equal(second.transport.closes.at(-1)?.reason, 'fleet protocol rejected');
  assert.equal(second.dispatchCount(), 0);
});

test('Given authenticated requests, when duplicates or unsupported input arrive, then admission precedes dispatch', async () => {
  const deferred = Promise.withResolvers<FleetResponseEnvelope>();
  let dispatchCount = 0;
  const subject = fixture({ dispatch: async () => { dispatchCount += 1; return deferred.promise; } });
  await authenticate(subject);
  const canonical = request(1, { value: 'one' });
  await subject.connection.receive(Buffer.from(encodeFleetFrame(canonical)));
  await subject.connection.receive(Buffer.from(encodeFleetFrame(canonical)));
  await subject.connection.receive(Buffer.from(encodeFleetFrame(request(1, { value: 'altered' }))));
  assert.equal(dispatchCount, 1);
  const conflict = decodeFleetFrame(Buffer.from(subject.transport.sent.at(-1) ?? ''));
  assert.equal(conflict.kind === 'response' && conflict.status === 'failure' ? conflict.error : undefined, 'FLEET_DUPLICATE_REQUEST_CONFLICT');
  const bothResults = subject.transport.waitForCount(subject.transport.sent.length + 2);
  deferred.resolve(successfulResponse(canonical));
  await bothResults;
  const duplicateResponses = subject.transport.sent.map((raw) => decodeFleetFrame(Buffer.from(raw)))
    .filter((frame) => frame.kind === 'response' && frame.status === 'success');
  assert.equal(duplicateResponses.length, 2);

  const denied = fixture();
  await authenticate(denied);
  await denied.connection.receive(Buffer.from(encodeFleetFrame(request(1, null, 'chat.send'))));
  assert.equal(denied.dispatchCount(), 0);
  assert.equal(denied.transport.closes.at(-1)?.reason, 'fleet protocol rejected');
});

test('Given frame and writer bounds, when either is exceeded, then input never reaches dispatch', async () => {
  const oversized = fixture();
  await oversized.connection.receive(Buffer.alloc(FLEET_MAX_FRAME_BYTES + 1));
  assert.equal(oversized.dispatchCount(), 0);

  const transport = new Transport();
  transport.blocked = true;
  const bounded = fixture({ transport, writer: { maxFrames: 1, maxBytes: 100_000 } });
  const hello = createFleetHello({ role: 'hub', signer: bounded.hub.signer, processEpoch: 'hub-epoch', capabilities: ['catalog.read'], transportMode: 'direct-wss' });
  await bounded.connection.receive(Buffer.from(encodeFleetFrame(hello)));
  assert.equal(bounded.transport.closes[0]?.reason, 'fleet writer capacity exceeded');
  assert.equal(bounded.dispatchCount(), 0);
});

test('Given an authenticated peer, when an event exceeds the frame bound, then it is dropped and the connection survives', async () => {
  const dropped: Array<[string, string]> = [];
  const errors: string[] = [];
  const subject = fixture({ onDroppedFrame: (code, kind) => { dropped.push([code, kind]); }, onError: (code) => { errors.push(code); } });
  await authenticate(subject);
  const sentBefore = subject.transport.sent.length;

  const oversized = subject.connection.publish('catalog.delta', 'event-big', { text: 'x'.repeat(FLEET_MAX_FRAME_BYTES) });
  const normal = subject.connection.publish('catalog.delta', 'event-small', { text: 'hello' });

  assert.equal(oversized, false);
  assert.equal(normal, true);
  assert.deepEqual(dropped, [['PROTOCOL_FRAME_TOO_LARGE', 'event']]);
  assert.deepEqual(errors, []);
  assert.deepEqual(subject.transport.closes, [], 'a frame the wire cannot carry never closes the connection');
  assert.equal(subject.transport.sent.length, sentBefore + 1);
  const last = decodeFleetFrame(Buffer.from(subject.transport.sent.at(-1) ?? ''));
  assert.equal(last.kind === 'event' && last.eventId, 'event-small');
});

test('Given an authenticated peer, when a response exceeds the frame bound, then the hub gets a bounded FLEET_FRAME_TOO_LARGE failure', async () => {
  const capabilities = ['catalog.read', 'chat.control'] as const;
  const subject = fixture({
    dispatch: async (incoming): Promise<FleetResponseEnvelope> => ({
      kind: 'response', protocolVersion: incoming.protocolVersion, connectionGeneration: incoming.connectionGeneration,
      requestId: incoming.requestId, target: incoming.target, status: 'success',
      sideEffect: incoming.operation === 'chat.send' ? 'applied' : 'none',
      body: { blob: 'y'.repeat(FLEET_MAX_FRAME_BYTES) },
    }),
  }, undefined, capabilities);
  await authenticate(subject, undefined, capabilities);

  const sentBefore = subject.transport.sent.length;
  await subject.connection.receive(Buffer.from(encodeFleetFrame(request(1))));
  await subject.transport.waitForCount(sentBefore + 1);
  const readReply = decodeFleetFrame(Buffer.from(subject.transport.sent.at(-1) ?? ''));
  assert.equal(readReply.kind, 'response');
  if (readReply.kind !== 'response') return;
  assert.equal(readReply.status, 'failure');
  assert.equal(readReply.status === 'failure' && readReply.error, 'FLEET_FRAME_TOO_LARGE');
  assert.equal(readReply.sideEffect, 'none');
  assert.equal(readReply.requestId, 'request-1');

  const mutation = { ...request(1, { value: 'go' }, 'chat.send'), requestId: 'request-2' };
  await subject.connection.receive(Buffer.from(encodeFleetFrame(mutation)));
  await subject.transport.waitForCount(sentBefore + 2);
  const mutationReply = decodeFleetFrame(Buffer.from(subject.transport.sent.at(-1) ?? ''));
  assert.equal(mutationReply.kind === 'response' && mutationReply.status === 'failure' && mutationReply.sideEffect, 'possible', 'an applied mutation whose result cannot be delivered is reported as uncertain, never as none');
  assert.deepEqual(subject.transport.closes, []);
});

test('Given a saturated writer, when publishing continues, then the connection closes without throwing into the publisher', async () => {
  const transport = new Transport();
  transport.blocked = true;
  const errors: string[] = [];
  const subject = fixture({ transport, writer: { maxFrames: 4, maxBytes: 1024 * 1024 }, onError: (code) => { errors.push(code); } });
  await authenticate(subject);

  const results: boolean[] = [];
  for (let index = 0; index < 8; index += 1) {
    results.push(subject.connection.publish('catalog.delta', `event-${index}`, { index }));
  }

  assert.ok(results.includes(false), 'the publisher learns the connection is gone');
  assert.deepEqual(subject.transport.closes[0], { code: 4008, reason: 'fleet writer capacity exceeded' });
  assert.ok(errors.includes('PROTOCOL_QUEUE_FULL'));
});
