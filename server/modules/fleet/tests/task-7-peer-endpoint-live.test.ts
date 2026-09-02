import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';

import { WebSocket, type RawData } from 'ws';

import {
  createFleetHello,
  createFleetProof,
  negotiateFleetChallenge,
  type FleetIdentitySigner,
} from '../protocol/auth.js';
import { decodeFleetFrame, encodeFleetFrame } from '../protocol/codec.js';
import { FleetConnectionRegistry, type FleetGenerationStore } from '../protocol/state-machine.js';
import type { FleetHelloFrame } from '../protocol/types.js';
import { createFleetPeerEndpoint } from '../peer/endpoint.js';
import { createPeerOperationDispatcher } from '../peer/operation-dispatcher.js';

function identity() {
  const keys = generateKeyPairSync('ed25519');
  const signer: FleetIdentitySigner = {
    installationId: randomUUID(),
    sign: async (challenge) => sign(null, challenge, keys.privateKey),
  };
  return { signer, publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() };
}

class Generations implements FleetGenerationStore {
  private generation = 0;
  async claimNext(): Promise<number> { this.generation += 1; return this.generation; }
}

async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timeout`)), 1_000);
      void promise.then(resolve, reject);
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function authenticate(
  url: string,
  hub: ReturnType<typeof identity>,
  peer: ReturnType<typeof identity>,
): Promise<Readonly<{ socket: WebSocket; generation: number; capabilities: readonly string[] }>> {
  const socket = new WebSocket(url);
  const ready = Promise.withResolvers<Readonly<{ generation: number; capabilities: readonly string[] }>>();
  const connectionId = randomUUID();
  const hubHello = createFleetHello({
    role: 'hub', signer: hub.signer, processEpoch: 'hub-epoch',
    capabilities: ['catalog.read'], transportMode: 'direct-wss', connectionId,
  });
  let peerHello: FleetHelloFrame | undefined;
  socket.on('message', (raw: RawData) => {
    void (async () => {
      const frame = decodeFleetFrame(raw);
      if (frame.kind === 'auth.hello') { peerHello = frame; return; }
      if (frame.kind === 'auth.proof' && peerHello !== undefined) {
        const negotiation = negotiateFleetChallenge(hubHello, peerHello, peer.signer.installationId);
        socket.send(encodeFleetFrame(await createFleetProof({
          signer: hub.signer, role: 'hub', connectionId, challenge: negotiation.challenge,
        })));
        return;
      }
      if (frame.kind === 'heartbeat' && peerHello !== undefined) {
        ready.resolve({ generation: frame.connectionGeneration, capabilities: peerHello.capabilities });
      }
    })().catch(ready.reject);
  });
  await bounded(once(socket, 'open'), 'socket open');
  socket.send(encodeFleetFrame(hubHello));
  const authenticated = await bounded(ready.promise, 'fleet auth');
  return { socket, ...authenticated };
}

test('Given a live peer endpoint, when authenticated requests are allowed or malformed, then only the typed request reaches local services', async (context) => {
  const hub = identity();
  const peer = identity();
  const server = createServer();
  let trustLookups = 0;
  let localCalls = 0;
  const endpoint = createFleetPeerEndpoint({
    server,
    browserUpgradeListeners: [],
    local: {
      role: 'peer', signer: peer.signer, processEpoch: 'peer-epoch',
      capabilities: ['catalog.read'], transportMode: 'direct-wss',
    },
    trust: { find: async (installationId) => {
      trustLookups += 1;
      return installationId === hub.signer.installationId
        ? { installationId, pinnedPublicKey: hub.publicKey, state: 'active' }
        : undefined;
    } },
    registry: new FleetConnectionRegistry(new Generations()),
    dispatch: createPeerOperationDispatcher(peer.signer.installationId, {
      'catalog.snapshot': async () => {
        localCalls += 1;
        return { capabilities: ['catalog.read'] };
      },
    }),
  });
  endpoint.start();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new TypeError('test server address is unavailable');
  const url = `ws://127.0.0.1:${address.port}/fleet-ws`;
  const clients: WebSocket[] = [];
  context.after(async () => {
    for (const client of clients) client.terminate();
    await endpoint.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const active = await authenticate(url, hub, peer);
  clients.push(active.socket);
  assert.deepEqual(active.capabilities, ['catalog.read']);
  const response = Promise.withResolvers<ReturnType<typeof decodeFleetFrame>>();
  active.socket.on('message', (raw: RawData) => {
    const frame = decodeFleetFrame(raw);
    if (frame.kind === 'response') response.resolve(frame);
  });
  active.socket.send(JSON.stringify({
    kind: 'request', protocolVersion: 'fleet/1', connectionGeneration: active.generation,
    requestId: 'catalog-rejected', operation: 'catalog.snapshot',
    target: { kind: 'host', hostId: peer.signer.installationId },
    body: { path: '/tmp/private', argv: ['sh'] },
  }));
  const rejected = await bounded(response.promise, 'rejected catalog response');
  assert.equal(rejected.kind, 'response');
  if (rejected.kind !== 'response') throw new TypeError('response frame expected');
  assert.equal(rejected.status, 'failure');
  assert.equal(localCalls, 0);

  const allowedResponse = Promise.withResolvers<ReturnType<typeof decodeFleetFrame>>();
  active.socket.on('message', (raw: RawData) => {
    const frame = decodeFleetFrame(raw);
    if (frame.kind === 'response' && frame.requestId === 'catalog') allowedResponse.resolve(frame);
  });
  active.socket.send(JSON.stringify({
    kind: 'request', protocolVersion: 'fleet/1', connectionGeneration: active.generation,
    requestId: 'catalog', operation: 'catalog.snapshot',
    target: { kind: 'host', hostId: peer.signer.installationId }, body: {},
  }));
  const result = await bounded(allowedResponse.promise, 'catalog response');
  assert.equal(result.kind, 'response');
  assert.equal(localCalls, 1);

  const malformed = await authenticate(url, hub, peer);
  clients.push(malformed.socket);
  const closed = once(malformed.socket, 'close');
  malformed.socket.send(JSON.stringify({
    kind: 'request', protocolVersion: 'fleet/1', connectionGeneration: malformed.generation,
    requestId: 'unknown', operation: 'arbitrary.shell',
    target: { kind: 'host', hostId: peer.signer.installationId }, body: { path: '/tmp', argv: ['sh'] },
  }));
  await bounded(closed, 'malformed close');
  assert.equal(localCalls, 1);
  assert.equal(trustLookups, 2);
});

test('Given a live peer endpoint, when an unauthenticated client sends a message over the frame bound, then ws closes it before assembly', async (context) => {
  const peer = identity();
  const server = createServer();
  const endpoint = createFleetPeerEndpoint({
    server,
    browserUpgradeListeners: [],
    local: { role: 'peer', signer: peer.signer, processEpoch: 'peer-epoch', capabilities: ['catalog.read'], transportMode: 'direct-wss' },
    trust: { find: async () => undefined },
    registry: new FleetConnectionRegistry(new Generations()),
    dispatch: createPeerOperationDispatcher(peer.signer.installationId, {}),
  });
  endpoint.start();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new TypeError('test server address is unavailable');
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/fleet-ws`);
  context.after(async () => {
    socket.terminate();
    await endpoint.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  await once(socket, 'open');
  const closed = once(socket, 'close');
  socket.send('x'.repeat(64 * 1024 + 1));
  const [code] = await bounded(closed, 'oversized frame close') as [number];
  assert.equal(code, 1009, 'the payload bound is enforced by ws itself, so nothing is buffered past 64 KiB before authentication');
});
