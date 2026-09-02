import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';

import { WebSocket, WebSocketServer, type RawData, type VerifyClientCallbackSync } from 'ws';

import { parseFleetRequestEnvelope, type FleetResponseEnvelope } from '../../../../shared/fleet.js';
import {
  createFleetHello,
  createFleetProof,
  FleetChallengeReplayGuard,
  negotiateFleetChallenge,
  verifyFleetProof,
  type FleetIdentitySigner,
} from '../protocol/auth.js';
import type { FleetWritableTransport } from '../protocol/bounded-writer.js';
import { decodeFleetFrame, encodeFleetFrame } from '../protocol/codec.js';
import { FleetProtocolConnection } from '../protocol/connection.js';
import { FleetConnectionRegistry, type FleetGenerationStore } from '../protocol/state-machine.js';
import { validateFleetUpgrade } from '../protocol/transport-policy.js';
import type { FleetHelloFrame } from '../protocol/types.js';

class GenerationStore implements FleetGenerationStore {
  generation = 0;
  async claimNext(): Promise<number> { this.generation += 1; return this.generation; }
}

function identity() {
  const keys = generateKeyPairSync('ed25519');
  const signer: FleetIdentitySigner = {
    installationId: randomUUID(),
    sign: async (challenge) => sign(null, challenge, keys.privateKey),
  };
  return { signer, publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() };
}

async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
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

function closeSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();
  const closed = once(socket, 'close').then(() => undefined);
  socket.close();
  return closed;
}

test('Given a real WebSocket pair, when the composed boundary authenticates then replay is denied before dispatch', async (context) => {
  const hub = identity();
  const peer = identity();
  const replayGuard = new FleetChallengeReplayGuard();
  const registry = new FleetConnectionRegistry(new GenerationStore());
  const authenticated = Promise.withResolvers<void>();
  const replayDenied = Promise.withResolvers<void>();
  const responsesReady = Promise.withResolvers<void>();
  const responses: FleetResponseEnvelope[] = [];
  let retainedPeerHello: FleetHelloFrame | undefined;
  let dispatcherCount = 0;
  const errors: string[] = [];
  const server = createServer();
  const wss = new WebSocketServer({
    server,
    verifyClient: (info: Parameters<VerifyClientCallbackSync>[0]) => validateFleetUpgrade({ url: info.req.url, headers: info.req.headers }).ok,
  });
  const clients: WebSocket[] = [];
  context.after(async () => {
    await Promise.all(clients.map(closeSocket));
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  wss.on('connection', (socket) => {
    const transport: FleetWritableTransport = {
      send: (payload, callback) => socket.send(payload, (error) => callback(error ?? undefined)),
      close: (code, reason) => socket.close(code, reason),
    };
    const connection = new FleetProtocolConnection({
      local: { role: 'peer', signer: peer.signer, processEpoch: 'peer-epoch', capabilities: ['catalog.read', 'chat.control'], transportMode: 'direct-wss' },
      trust: { find: async (installationId) => ({ installationId, pinnedPublicKey: hub.publicKey, state: 'active' }) },
      replayGuard, registry, transport,
      createHello: (connectionId) => {
        retainedPeerHello ??= createFleetHello({
          role: 'peer', signer: peer.signer, processEpoch: 'peer-epoch',
          capabilities: ['catalog.read', 'chat.control'], transportMode: 'direct-wss', connectionId,
        });
        return retainedPeerHello;
      },
      dispatch: async (request) => {
        dispatcherCount += 1;
        return {
          kind: 'response', protocolVersion: request.protocolVersion, connectionGeneration: request.connectionGeneration,
          requestId: request.requestId, target: request.target, status: 'success', sideEffect: 'none', body: null,
        };
      },
      onError: (code) => { errors.push(code); if (code === 'AUTH_REPLAYED') replayDenied.resolve(); },
    });
    socket.on('message', (raw: RawData) => { void connection.receive(raw); });
    socket.on('close', () => connection.stop());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new TypeError('test server has no TCP address');
  const endpoint = `ws://127.0.0.1:${address.port}/fleet-ws`;
  const connectionId = randomUUID();
  const hubHello = createFleetHello({
    role: 'hub', signer: hub.signer, processEpoch: 'hub-epoch', capabilities: ['catalog.read', 'chat.control'],
    transportMode: 'direct-wss', connectionId,
  });
  let savedProof: Awaited<ReturnType<typeof createFleetProof>> | undefined;

  async function connect(): Promise<WebSocket> {
    const client = new WebSocket(endpoint);
    clients.push(client);
    await once(client, 'open');
    let peerHello: FleetHelloFrame | undefined;
    client.on('message', (raw: RawData) => {
      void (async () => {
        const frame = decodeFleetFrame(raw);
        if (frame.kind === 'auth.hello') { peerHello = frame; return; }
        if (frame.kind === 'auth.proof' && peerHello !== undefined) {
          const negotiation = negotiateFleetChallenge(hubHello, peerHello, peer.signer.installationId);
          verifyFleetProof({ proof: frame, remoteHello: peerHello, pinnedPublicKey: peer.publicKey, challenge: negotiation.challenge });
          savedProof ??= await createFleetProof({ signer: hub.signer, role: 'hub', connectionId, challenge: negotiation.challenge });
          client.send(encodeFleetFrame(savedProof));
          return;
        }
        if (frame.kind === 'heartbeat') authenticated.resolve();
        if (frame.kind === 'response') { responses.push(frame); if (responses.length === 3) responsesReady.resolve(); }
      })().catch(() => client.close(4003, 'fleet authentication rejected'));
    });
    client.send(encodeFleetFrame(hubHello));
    return client;
  }

  const active = await connect();
  await withTimeout(authenticated.promise, 'auth');
  const canonical = parseFleetRequestEnvelope({
    kind: 'request', protocolVersion: 'fleet/1', connectionGeneration: 1, requestId: 'live-request',
    operation: 'chat.send', target: { kind: 'session', hostId: peer.signer.installationId, localId: 'live-session' }, body: { value: 'one' },
  });
  active.send(encodeFleetFrame(canonical));
  active.send(encodeFleetFrame(canonical));
  active.send(encodeFleetFrame(parseFleetRequestEnvelope({ ...canonical, body: { value: 'altered' } })));
  await withTimeout(responsesReady.promise, 'duplicate responses');
  assert.equal(dispatcherCount, 1);
  assert.equal(responses.filter((response) => response.status === 'success').length, 2);
  assert.equal(responses.filter((response) => response.status === 'failure' && response.error === 'FLEET_DUPLICATE_REQUEST_CONFLICT').length, 1);
  const staleClosed = new Promise<void>((resolve) => active.once('close', () => resolve()));
  active.send(JSON.stringify({ ...canonical, connectionGeneration: 2, requestId: 'stale-request' }));
  await withTimeout(staleClosed, 'stale close');
  assert.equal(dispatcherCount, 1);
  await connect();
  await withTimeout(replayDenied.promise, 'replay');
  assert.equal(dispatcherCount, 1);
  assert.deepEqual(errors, ['PROTOCOL_STALE_GENERATION', 'AUTH_REPLAYED']);
});


