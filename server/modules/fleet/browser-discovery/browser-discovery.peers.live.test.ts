import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import test from 'node:test';

import { WebSocket } from 'ws';

import { createWebSocketServer } from '../../websocket/index.js';
import { FleetCatalogAggregator } from '../catalog/aggregator.js';
import type { FleetCatalogMaterial } from '../catalog/types.js';
import { HubPeerConnectionRegistry } from '../hub/connection/registry.js';
import type { HubConnectionScheduler, HubPeerRecord, HubPeerStatus } from '../hub/connection/types.js';
import { dialFleetWebSocket } from '../hub/connection/websocket-dialer.js';
import { PeerCatalogPublisher } from '../peer/catalog-publisher.js';
import { createFleetPeerEndpoint } from '../peer/endpoint.js';
import { createPeerOperationDispatcher } from '../peer/operation-dispatcher.js';
import type { FleetIdentitySigner } from '../protocol/auth.js';
import { FleetConnectionRegistry, type FleetGenerationStore } from '../protocol/state-machine.js';
import type { FleetProtocolFrame } from '../protocol/types.js';

import { createFleetBrowserDiscovery } from './browser-discovery.js';
import { fleetBrowserDiscoveryGateway } from './gateway.js';

function identity() {
  const keys = generateKeyPairSync('ed25519');
  const signer: FleetIdentitySigner = {
    installationId: randomUUID(),
    sign: async (challenge) => sign(null, challenge, keys.privateKey),
  };
  return { signer, publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() };
}

class Generations implements FleetGenerationStore {
  private value = 0;
  async claimNext(): Promise<number> { this.value += 1; return this.value; }
}

function material(hostId: string): FleetCatalogMaterial {
  return {
    host: { hostId, displayLabel: 'studio', capabilities: ['catalog.read'] },
    projects: [{ localId: 'project', path: `/secret/${hostId}`, displayName: 'collision', isStarred: false }],
    sessions: [{ localId: 'session', projectLocalId: 'project', provider: 'gjc', summary: 'collision', lastActivityMs: 1 }],
    panes: [],
    processing: [],
    health: {
      external: { ok: true, lastOkRevision: 1, consecutiveFailures: 0 },
      live: { ok: true, lastOkRevision: 1, consecutiveFailures: 0 },
    },
  };
}

type PeerStartInput = Readonly<{
  peer: ReturnType<typeof identity>;
  hub: ReturnType<typeof identity>;
  generations: Generations;
  port?: number;
}>;

async function startPeer(input: PeerStartInput) {
  const { peer, hub, generations, port = 0 } = input;
  const server = createServer();
  let stopped = false;
  const processEpoch = randomUUID();
  const publisher = new PeerCatalogPublisher({
    epoch: processEpoch,
    read: async () => material(peer.signer.installationId),
    subscribe: () => () => undefined,
  });
  const endpoint = createFleetPeerEndpoint({
    server,
    browserUpgradeListeners: [],
    local: { role: 'peer', signer: peer.signer, processEpoch, capabilities: ['catalog.read'], transportMode: 'ssh-loopback' },
    trust: { find: async (installationId) => installationId === hub.signer.installationId
      ? { installationId, pinnedPublicKey: hub.publicKey, state: 'active' }
      : undefined },
    registry: new FleetConnectionRegistry(generations),
    dispatch: createPeerOperationDispatcher(peer.signer.installationId, {
      'catalog.snapshot': async () => publisher.snapshotBody(),
    }),
    catalogPublisher: publisher,
  });
  endpoint.start();
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    port: address.port,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      await endpoint.stop();
      publisher.stop();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

const scheduler: HubConnectionScheduler = {
  get nowMs() { return Date.now(); },
  schedule: (delayMs, callback) => {
    const timer = setTimeout(callback, delayMs);
    timer.unref();
    return { cancel: () => clearTimeout(timer) };
  },
};

function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<T>((_resolve, reject) => {
    timer = setTimeout(() => reject(new TypeError(`${label} timed out`)), 5_000);
  });
  return Promise.race([promise, timeout]).finally(() => { if (timer !== undefined) clearTimeout(timer); });
}

function signal(
  subscribe: (listener: (value: HubPeerStatus) => void) => () => void,
  peerId: string,
  state: HubPeerStatus['state'],
): Promise<void> {
  const result = Promise.withResolvers<void>();
  const unsubscribe = subscribe((status) => {
    if (status.peerId === peerId && status.state === state) {
      unsubscribe();
      result.resolve();
    }
  });
  return bounded(result.promise, `${peerId} ${state}`);
}

function frames(socket: WebSocket, count: number): Promise<readonly Readonly<Record<string, unknown>>[]> {
  const result = Promise.withResolvers<readonly Readonly<Record<string, unknown>>[]>();
  const values: Readonly<Record<string, unknown>>[] = [];
  const listener = (payload: WebSocket.RawData) => {
    values.push(JSON.parse(String(payload)) as Readonly<Record<string, unknown>>);
    if (values.length === count) {
      socket.off('message', listener);
      result.resolve(values);
    }
  };
  socket.on('message', listener);
  return bounded(result.promise, `${count} browser frames`).finally(() => socket.off('message', listener));
}

async function stopServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test('Given a hub and two real peers, when an owner browser subscribes and one peer fails and recovers, then only its state changes', async (context) => {
  const hub = identity();
  const peerA = identity();
  const peerB = identity();
  const generationsA = new Generations();
  const generationsB = new Generations();
  const runtimeA = await startPeer({ peer: peerA, hub, generations: generationsA });
  const runtimeB = await startPeer({ peer: peerB, hub, generations: generationsB });
  const replacementPeers: Array<Awaited<ReturnType<typeof startPeer>>> = [];
  const records: readonly HubPeerRecord[] = [
    { peerId: peerA.signer.installationId, url: `ws://127.0.0.1:${runtimeA.port}/fleet-ws`, transportMode: 'ssh-loopback', pinnedPublicKey: peerA.publicKey, enrollmentState: 'enrolled' },
    { peerId: peerB.signer.installationId, url: `ws://127.0.0.1:${runtimeB.port}/fleet-ws`, transportMode: 'ssh-loopback', pinnedPublicKey: peerB.publicKey, enrollmentState: 'enrolled' },
  ];
  const catalog = new FleetCatalogAggregator((hostId) => { registry.requestCatalogSnapshot(hostId); });
  const onFrame = (peerId: string, frame: FleetProtocolFrame): void => {
    const status = registry.status(peerId);
    if (status?.generation === null || status?.generation === undefined || status.peerProcessEpoch === null) return;
    const isSnapshot = (frame.kind === 'event' && frame.event === 'catalog.snapshot')
      || (frame.kind === 'response' && frame.requestId.startsWith('catalog-resync-') && frame.status === 'success');
    if (isSnapshot && catalog.snapshot(peerId, frame.connectionGeneration, status.peerProcessEpoch, frame.body).kind === 'applied') {
      registry.markSynchronized(peerId);
    }
  };
  const registry = new HubPeerConnectionRegistry({
    peers: { list: () => records },
    local: { signer: hub.signer, processEpoch: randomUUID(), capabilities: ['catalog.read'] },
    requiredCapabilities: ['catalog.read'], scheduler, random: () => 0.5,
    dial: dialFleetWebSocket, recordNegotiation: () => undefined, onFrame,
  });
  const unsubscribe = registry.subscribeStatus((status) => {
    if (status.generation !== null && status.peerProcessEpoch !== null
      && catalog.host(status.peerId)?.generation !== status.generation) {
      catalog.connected(status.peerId, status.generation, status.peerProcessEpoch);
    }
    if (status.state === 'offline') catalog.offline(status.peerId);
  });
  context.after(async () => {
    unsubscribe();
    registry.stop();
    await Promise.all([
      runtimeA.stop(),
      runtimeB.stop(),
      ...replacementPeers.map((runtime) => runtime.stop()),
    ]);
  });
  const online = Promise.all(records.map((record) => signal(
    registry.subscribeStatus.bind(registry),
    record.peerId,
    'online',
  )));
  registry.start();
  await online;
  const snapshots = Promise.all(records.map((record) => new Promise<void>((resolve) => {
    if (catalog.host(record.peerId) !== undefined) { resolve(); return; }
    const release = catalog.subscribe((notification) => {
      if (notification.hostId === record.peerId && notification.kind === 'snapshot') { release(); resolve(); }
    });
    const requestId = registry.requestCatalogSnapshot(record.peerId);
    if (requestId === undefined) throw new TypeError(`snapshot request unavailable for ${record.peerId}`);
  })));
  await bounded(snapshots, 'peer catalog snapshots');
  const discovery = createFleetBrowserDiscovery({
    local: { hostId: hub.signer.installationId, displayLabel: 'controller', capabilities: ['catalog.read'] },
    peers: { list: () => records.map((record) => ({ peerId: record.peerId, displayLabel: 'studio', enrollmentState: 'enrolled' })) },
    registry,
    catalog,
  });
  fleetBrowserDiscoveryGateway.bind(discovery);
  const browserServer = createServer();
  const wss = createWebSocketServer(browserServer, {
    verifyClient: { authenticateWebSocket: () => ({ id: 1, username: 'owner' }) },
    fleet: { authMode: 'password' },
  } as never);
  const browserPort = await new Promise<number>((resolve) => browserServer.listen(0, '127.0.0.1', () => {
    const address = browserServer.address();
    if (address === null || typeof address === 'string') throw new TypeError('browser address unavailable');
    resolve(address.port);
  }));
  const client = new WebSocket(`ws://127.0.0.1:${browserPort}/ws`);
  context.after(async () => {
    client.terminate();
    fleetBrowserDiscoveryGateway.unbind(discovery);
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await stopServer(browserServer);
  });
  await new Promise<void>((resolve, reject) => { client.once('open', resolve); client.once('error', reject); });
  const initial = frames(client, 5);
  client.send(JSON.stringify({ type: 'fleet.subscribe', protocolVersion: 'fleet/1' }));
  const received = await initial;
  assert.deepEqual(received.map((frame) => frame.kind), ['fleet.hosts', 'fleet.host_state', 'fleet.catalog.snapshot', 'fleet.host_state', 'fleet.catalog.snapshot']);
  assert.equal(JSON.stringify(received).includes('/secret/'), false);

  const offline = signal(registry.subscribeStatus.bind(registry), peerA.signer.installationId, 'offline');
  const update = frames(client, 1);
  await runtimeA.stop();
  await offline;
  const [changed] = await update;
  assert.equal((changed?.host as Readonly<{ hostId: string }>).hostId, peerA.signer.installationId);
  assert.equal(registry.status(peerB.signer.installationId)?.state, 'online');

  const recovered = signal(registry.subscribeStatus.bind(registry), peerA.signer.installationId, 'online');
  replacementPeers.push(await startPeer({
    peer: peerA,
    hub,
    generations: generationsA,
    port: runtimeA.port,
  }));
  registry.reconnect(peerA.signer.installationId);
  await recovered;
  assert.equal(registry.status(peerA.signer.installationId)?.state, 'online');
  assert.equal(registry.status(peerB.signer.installationId)?.state, 'online');
});
