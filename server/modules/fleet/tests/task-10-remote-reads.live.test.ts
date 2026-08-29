import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import test from 'node:test';

import { HubPeerConnectionRegistry } from '../hub/connection/registry.js';
import type { HubConnectionScheduler, HubPeerRecord, HubPeerStatus } from '../hub/connection/types.js';
import { dialFleetWebSocket } from '../hub/connection/websocket-dialer.js';
import { createFleetPeerEndpoint } from '../peer/endpoint.js';
import { createPeerOperationDispatcher } from '../peer/operation-dispatcher.js';
import type { FleetIdentitySigner } from '../protocol/auth.js';
import { FleetConnectionRegistry, type FleetGenerationStore } from '../protocol/state-machine.js';
import { FleetReadClient } from '../rpc/reads/client.js';
import { createFleetReadHandlers, type FleetReadServices } from '../rpc/reads/peer.js';

function identity(installationId: string = randomUUID()) {
  const keys = generateKeyPairSync('ed25519');
  const signer: FleetIdentitySigner = { installationId, sign: async (challenge) => sign(null, challenge, keys.privateKey) };
  return { signer, publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() };
}

class Generations implements FleetGenerationStore {
  private value = 0;
  async claimNext(): Promise<number> { this.value += 1; return this.value; }
}

type PeerRuntime = Readonly<{ readonly port: number; readonly stop: () => Promise<void> }>;

function peerServices(label: string, calls: string[]): FleetReadServices {
  const read = (kind: string, localId: string) => { calls.push(`${kind}:${localId}`); return Promise.resolve({ kind, localId, value: label }); };
  return {
    sessionMetadata: (localId) => read('metadata', localId), history: (localId) => read('history', localId),
    search: (localId) => read('search', localId), prompt: (localId) => read('prompt', localId),
    approval: (localId) => read('approval', localId), capturePane: (target) => read('pane', target.localId),
    providerInventory: (localId) => read('inventory', localId),
    chatSubscription: (localId) => read('subscription', localId),
    pathSuggestions: (localId) => read('suggestions', localId),
  };
}

async function startPeer(peer: ReturnType<typeof identity>, hub: ReturnType<typeof identity>, services: FleetReadServices): Promise<PeerRuntime> {
  const server: Server = createServer();
  const endpoint = createFleetPeerEndpoint({
    server, browserUpgradeListeners: [],
    local: { role: 'peer', signer: peer.signer, processEpoch: randomUUID(), capabilities: ['session.read', 'prompt.respond', 'pane.read'], transportMode: 'ssh-loopback' },
    trust: { find: async (installationId) => installationId === hub.signer.installationId ? { installationId, pinnedPublicKey: hub.publicKey, state: 'active' } : undefined },
    registry: new FleetConnectionRegistry(new Generations()),
    dispatch: createPeerOperationDispatcher(peer.signer.installationId, createFleetReadHandlers(peer.signer.installationId, services)),
  });
  endpoint.start();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new TypeError('peer address unavailable');
  return { port: address.port, stop: async () => { await endpoint.stop(); await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error))); } };
}

function onlineSignal(registry: HubPeerConnectionRegistry, peerId: string): Promise<HubPeerStatus> {
  const result = Promise.withResolvers<HubPeerStatus>();
  const unsubscribe = registry.subscribe((status) => { if (status.peerId === peerId && status.state === 'online') { unsubscribe(); result.resolve(status); } });
  const timer = setTimeout(() => { unsubscribe(); result.reject(new TypeError('peer online timeout')); }, 2_000);
  return result.promise.finally(() => clearTimeout(timer));
}

const scheduler: HubConnectionScheduler = {
  get nowMs() { return Date.now(); },
  schedule: (delayMs, callback) => { const timer = setTimeout(callback, delayMs); timer.unref(); return { cancel: () => clearTimeout(timer) }; },
};

function session(hostId: string) { return { kind: 'session' as const, hostId, localId: 'same-local-id' }; }
function project(hostId: string) { return { kind: 'project' as const, hostId, localId: 'same-project-id' }; }
function pane(hostId: string) { return { kind: 'pane' as const, hostId, localId: 'same-pane-id', lane: 'external', tmux: { socketPath: `/tmp/${hostId}/tmux.sock`, sessionId: '$1', windowId: '@1', paneId: '%1' }, process: { pid: 4001, startedAtMs: 1001 } }; }

async function readPeer(client: FleetReadClient, hostId: string, deadlineAtMs: number) {
  return Promise.all([
    client.history(session(hostId), { deadlineAtMs, limit: 20, offset: 0, includeImages: false }),
    client.search(project(hostId), { deadlineAtMs, query: 'needle', limit: 20 }),
    client.prompt(session(hostId), deadlineAtMs), client.capturePane(pane(hostId), deadlineAtMs),
  ]);
}

test('Given a live hub and two authenticated collision peers, when history search prompt and pane reads run, then each peer returns only its own value', async (context) => {
  // Given
  const hub = identity(); const peerA = identity(); const peerB = identity(); const callsA: string[] = []; const callsB: string[] = [];
  const runtimeA = await startPeer(peerA, hub, peerServices('peer-a', callsA));
  const runtimeB = await startPeer(peerB, hub, peerServices('peer-b', callsB));
  const records: readonly HubPeerRecord[] = [
    { peerId: peerA.signer.installationId, url: `ws://127.0.0.1:${runtimeA.port}/fleet-ws`, transportMode: 'ssh-loopback', pinnedPublicKey: peerA.publicKey, enrollmentState: 'enrolled' },
    { peerId: peerB.signer.installationId, url: `ws://127.0.0.1:${runtimeB.port}/fleet-ws`, transportMode: 'ssh-loopback', pinnedPublicKey: peerB.publicKey, enrollmentState: 'enrolled' },
  ];
  const registry = new HubPeerConnectionRegistry({ peers: { list: () => records }, local: { signer: hub.signer, processEpoch: randomUUID(), capabilities: ['session.read', 'prompt.respond', 'pane.read'] }, scheduler, random: () => 0.5, dial: dialFleetWebSocket, recordNegotiation: () => undefined, onFrame: () => undefined });
  context.after(async () => { registry.stop(); await Promise.all([runtimeA.stop(), runtimeB.stop()]); });
  const onlineA = onlineSignal(registry, peerA.signer.installationId); const onlineB = onlineSignal(registry, peerB.signer.installationId);
  registry.start(); await Promise.all([onlineA, onlineB]);

  // When
  const client = new FleetReadClient(registry); const deadlineAtMs = Date.now() + 5_000;
  const [valuesA, valuesB] = await Promise.all([readPeer(client, peerA.signer.installationId, deadlineAtMs), readPeer(client, peerB.signer.installationId, deadlineAtMs)]);

  // Then
  assert.ok(valuesA.every((value) => JSON.stringify(value).includes('peer-a')));
  assert.ok(valuesB.every((value) => JSON.stringify(value).includes('peer-b')));
  assert.deepEqual(callsA, ['history:same-local-id', 'search:same-project-id', 'prompt:same-local-id', 'pane:same-pane-id']);
  assert.deepEqual(callsB, callsA);
});
