import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import test from 'node:test';

import { createFleetPeerEndpoint } from '../peer/endpoint.js';
import type { FleetIdentitySigner } from '../protocol/auth.js';
import { FleetConnectionRegistry, type FleetGenerationStore } from '../protocol/state-machine.js';
import { HubPeerConnectionRegistry } from '../hub/connection/registry.js';
import type { HubConnectionScheduler, HubPeerRecord, HubPeerStatus } from '../hub/connection/types.js';
import { dialFleetWebSocket } from '../hub/connection/websocket-dialer.js';

function identity(installationId: string = randomUUID()) {
  const keys = generateKeyPairSync('ed25519');
  const signer: FleetIdentitySigner = { installationId, sign: async (challenge) => sign(null, challenge, keys.privateKey) };
  return { signer, publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() };
}

class Generations implements FleetGenerationStore {
  private value = 0;
  async claimNext(): Promise<number> { this.value += 1; return this.value; }
}

type PeerRuntime = Readonly<{ server: Server; stop(): Promise<void> }>;

async function startPeer(
  peer: ReturnType<typeof identity>,
  hub: ReturnType<typeof identity>,
  generations: Generations,
  port = 0,
): Promise<Readonly<{ runtime: PeerRuntime; port: number }>> {
  const server = createServer();
  const endpoint = createFleetPeerEndpoint({
    server, browserUpgradeListeners: [],
    local: { role: 'peer', signer: peer.signer, processEpoch: randomUUID(), capabilities: ['catalog.read'], transportMode: 'ssh-loopback' },
    trust: { find: async (installationId) => installationId === hub.signer.installationId
      ? { installationId, pinnedPublicKey: hub.publicKey, state: 'active' }
      : undefined },
    registry: new FleetConnectionRegistry(generations),
    dispatch: async () => { throw new TypeError('live health driver does not dispatch operations'); },
  });
  endpoint.start();
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new TypeError('peer address unavailable');
  let stopped = false;
  return {
    port: address.port,
    runtime: {
      server,
      stop: async () => {
        if (stopped) return;
        stopped = true;
        await endpoint.stop();
        await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
      },
    },
  };
}

function stateSignal(registry: HubPeerConnectionRegistry, peerId: string, state: HubPeerStatus['state']): Promise<HubPeerStatus> {
  const result = Promise.withResolvers<HubPeerStatus>();
  const unsubscribe = registry.subscribe((status) => {
    if (status.peerId === peerId && status.state === state) { unsubscribe(); result.resolve(status); }
  });
  let timer: NodeJS.Timeout | undefined;
  const bounded = new Promise<HubPeerStatus>((resolve, reject) => {
    timer = setTimeout(() => { unsubscribe(); reject(new Error(`${peerId} ${state} timeout`)); }, 2_000);
    void result.promise.then(resolve, reject);
  });
  return bounded.finally(() => { if (timer !== undefined) clearTimeout(timer); });
}

const scheduler: HubConnectionScheduler = {
  get nowMs() { return Date.now(); },
  schedule: (delayMs, callback) => {
    const timer = setTimeout(callback, delayMs); timer.unref();
    return { cancel: () => clearTimeout(timer) };
  },
};

test('Given two live peers, when one restarts with an unapproved key, then the healthy peer stays online and the changed peer fails closed', async (context) => {
  // Given
  const hub = identity(); const healthy = identity(); const changed = identity();
  const healthyGeneration = new Generations(); const changedGeneration = new Generations();
  const healthyServer = await startPeer(healthy, hub, healthyGeneration);
  const changedServer = await startPeer(changed, hub, changedGeneration);
  const replacements: PeerRuntime[] = [];
  context.after(async () => {
    registry.stop();
    await Promise.all([healthyServer.runtime.stop(), changedServer.runtime.stop(), ...replacements.map((runtime) => runtime.stop())]);
  });
  const records: readonly HubPeerRecord[] = [
    { peerId: healthy.signer.installationId, url: `ws://127.0.0.1:${healthyServer.port}/fleet-ws`, transportMode: 'ssh-loopback', pinnedPublicKey: healthy.publicKey, enrollmentState: 'enrolled' },
    { peerId: changed.signer.installationId, url: `ws://127.0.0.1:${changedServer.port}/fleet-ws`, transportMode: 'ssh-loopback', pinnedPublicKey: changed.publicKey, enrollmentState: 'enrolled' },
  ];
  const registry = new HubPeerConnectionRegistry({
    peers: { list: () => records }, local: { signer: hub.signer, processEpoch: randomUUID(), capabilities: ['catalog.read'] },
    requiredCapabilities: ['catalog.read'], scheduler, random: () => 0.5, dial: dialFleetWebSocket,
    recordNegotiation: () => undefined, onFrame: () => undefined,
  });
  const healthyOnline = stateSignal(registry, healthy.signer.installationId, 'online');
  const changedOnline = stateSignal(registry, changed.signer.installationId, 'online');
  registry.start();
  await Promise.all([healthyOnline, changedOnline]);

  // When
  const changedOffline = stateSignal(registry, changed.signer.installationId, 'offline');
  await changedServer.runtime.stop();
  await changedOffline;
  const impostor = identity(changed.signer.installationId);
  const restarted = await startPeer(impostor, hub, changedGeneration, changedServer.port);
  replacements.push(restarted.runtime);
  const rejected = stateSignal(registry, changed.signer.installationId, 'offline');
  registry.reconnect(changed.signer.installationId);
  await rejected;

  // Then
  assert.equal(registry.status(healthy.signer.installationId)?.state, 'online');
  assert.equal(registry.status(changed.signer.installationId)?.state, 'offline');
  assert.equal(registry.status(changed.signer.installationId)?.generation, 1);
});
