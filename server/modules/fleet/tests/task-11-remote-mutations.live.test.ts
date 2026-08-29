import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { createServer } from 'node:http';
import test from 'node:test';

import { HubPeerConnectionRegistry } from '../hub/connection/registry.js';
import type { HubConnectionScheduler, HubPeerRecord, HubPeerStatus } from '../hub/connection/types.js';
import { dialFleetWebSocket } from '../hub/connection/websocket-dialer.js';
import { createFleetPeerEndpoint } from '../peer/endpoint.js';
import { createPeerOperationDispatcher } from '../peer/operation-dispatcher.js';
import type { FleetIdentitySigner } from '../protocol/auth.js';
import { FleetConnectionRegistry, type FleetGenerationStore } from '../protocol/state-machine.js';
import { FleetMutationClient, FleetMutationClientError, createFleetMutationHandlers, type FleetMutationServices, type MutationActionTarget } from '../rpc/mutations/index.js';
import { FleetReadClient } from '../rpc/reads/index.js';

function identity(installationId = randomUUID()) { const keys = generateKeyPairSync('ed25519'); const signer: FleetIdentitySigner = { installationId, sign: async (challenge) => sign(null, challenge, keys.privateKey) }; return { signer, publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() }; }
class Generations implements FleetGenerationStore { private value = 0; async claimNext(): Promise<number> { this.value += 1; return this.value; } }
const scheduler: HubConnectionScheduler = { get nowMs() { return Date.now(); }, schedule: (delayMs, callback) => { const timer = setTimeout(callback, delayMs); timer.unref(); return { cancel: () => clearTimeout(timer) }; } };
const capabilities = ['session.read', 'chat.control', 'prompt.respond', 'terminal.input', 'session.spawn', 'session.terminate'] as const;
const session = (hostId: string) => ({ kind: 'session', hostId, localId: 'collision-session' } as const);
const project = (hostId: string) => ({ kind: 'project', hostId, localId: 'collision-project' } as const);
const pane = (hostId: string) => ({ kind: 'pane', hostId, localId: 'collision-pane', lane: 'external', tmux: { socketPath: '/tmp/collision.sock', sessionId: '$1', windowId: '@1', paneId: '%1' }, process: { pid: 4001, startedAtMs: 1001 } } as const);
function services(log: string[], afterAction: () => void): FleetMutationServices {
  const verified: MutationActionTarget = { token: 'verified' }; const action = async (name: string): Promise<void> => { log.push(`action:${name}`); afterAction(); };
  return { verifySession: async () => { log.push('verify:session'); return verified; }, verifyPane: async () => { log.push('verify:pane'); return verified; }, verifySpawn: async () => { log.push('verify:spawn'); return { cwd: '/home/peer/workspace' }; }, finalCheck: async (request) => { log.push(`final:${request.requestId}`); }, send: async () => action('send'), abort: async () => action('abort'), interrupt: async () => action('interrupt'), escape: async () => action('escape'), respondPrompt: async () => { await action('prompt'); return { action: 'selected' }; }, respondApproval: async () => action('approval'), spawn: async () => { await action('spawn'); return { ok: true }; }, terminateProcess: async () => action('process'), terminatePane: async () => action('pane'), terminateSession: async () => action('session') };
}
async function startPeer(peer: ReturnType<typeof identity>, hub: ReturnType<typeof identity>, log: string[]) {
  let afterAction = (): void => {};
  const server = createServer(); const handlers = { ...createFleetMutationHandlers(peer.signer.installationId, services(log, () => afterAction())), 'session.history': async () => { log.push('read:transcript'); return { actions: log.filter((entry) => entry.startsWith('action:')).length }; }, 'session.read': async () => { log.push('read:discovery'); return { present: true }; }, 'session.search': async () => null } as const;
  const endpoint = createFleetPeerEndpoint({ server, browserUpgradeListeners: [], local: { role: 'peer', signer: peer.signer, processEpoch: randomUUID(), capabilities, transportMode: 'ssh-loopback' }, trust: { find: async (id) => id === hub.signer.installationId ? { installationId: id, pinnedPublicKey: hub.publicKey, state: 'active' } : undefined }, registry: new FleetConnectionRegistry(new Generations()), dispatch: createPeerOperationDispatcher(peer.signer.installationId, handlers) });
  endpoint.start(); await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); if (address === null || typeof address === 'string') throw new TypeError('peer address unavailable');
  return { port: address.port, setAfterAction: (callback: () => void) => { afterAction = callback; }, stop: async () => { await endpoint.stop(); await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error))); } };
}
function online(registry: HubPeerConnectionRegistry, peerId: string): Promise<HubPeerStatus> { const result = Promise.withResolvers<HubPeerStatus>(); const release = registry.subscribe((status) => { if (status.peerId === peerId && status.state === 'online') { release(); result.resolve(status); } }); const timer = setTimeout(() => { release(); result.reject(new TypeError('online timeout')); }, 2_000); timer.unref(); return result.promise.finally(() => clearTimeout(timer)); }

test('Given two authenticated collision peers, when every mutation family targets A and a collision ID targets B, then logs stay host-qualified', async (context) => {
  const hub = identity(); const a = identity(); const b = identity(); const logA: string[] = []; const logB: string[] = [];
  const peerA = await startPeer(a, hub, logA); const peerB = await startPeer(b, hub, logB);
  const records: readonly HubPeerRecord[] = [{ peerId: a.signer.installationId, url: `ws://127.0.0.1:${peerA.port}/fleet-ws`, transportMode: 'ssh-loopback', pinnedPublicKey: a.publicKey, enrollmentState: 'enrolled' }, { peerId: b.signer.installationId, url: `ws://127.0.0.1:${peerB.port}/fleet-ws`, transportMode: 'ssh-loopback', pinnedPublicKey: b.publicKey, enrollmentState: 'enrolled' }];
  const registry = new HubPeerConnectionRegistry({ peers: { list: () => records }, local: { signer: hub.signer, processEpoch: randomUUID(), capabilities }, scheduler, random: () => 0.5, dial: dialFleetWebSocket, recordNegotiation: () => undefined, onFrame: () => undefined });
  context.after(async () => { registry.stop(); await Promise.all([peerA.stop(), peerB.stop()]); }); const readyA = online(registry, a.signer.installationId); const readyB = online(registry, b.signer.installationId); registry.start(); await Promise.all([readyA, readyB]);
  const client = new FleetMutationClient(registry); const deadlineAtMs = Date.now() + 5_000; const meta = (requestId: string) => ({ requestId, deadlineAtMs });
  await client.sendChat(session(a.signer.installationId), { ...meta('collision-id'), message: 'chat' }); await client.abortChat(session(a.signer.installationId), meta('abort')); await client.sendPane(pane(a.signer.installationId), { ...meta('pane-send'), message: 'pane' }); await client.interrupt(pane(a.signer.installationId), meta('interrupt')); await client.escape(pane(a.signer.installationId), meta('escape')); await client.respondPrompt(session(a.signer.installationId), { ...meta('prompt'), response: 'choices', promptId: '0123456789abcdef0123456789abcdef', choices: [1] }); await client.respondApproval(session(a.signer.installationId), { ...meta('approval'), decision: 'approve-once' }); await client.spawn(project(a.signer.installationId), { ...meta('spawn'), name: 'agent', cwd: 'workspace' }); await client.terminateProcess(pane(a.signer.installationId), meta('process')); await client.terminatePane(pane(a.signer.installationId), meta('pane')); await client.terminateSession(pane(a.signer.installationId), meta('session'));
  assert.equal(logB.length, 0); await client.sendChat(session(b.signer.installationId), { ...meta('collision-id'), message: 'peer-b' });
  assert.equal(logA.filter((line) => line.startsWith('action:')).length, 11); assert.deepEqual(logB, ['verify:session', 'final:collision-id', 'action:send']);
});

test('Given an authenticated socket disconnects after dispatch, when real transcript and discovery reads reconcile, then unknown remains stable and the mutation event is not replayed', async (context) => {
  const hub = identity(); const remote = identity(); const log: string[] = []; const peer = await startPeer(remote, hub, log);
  const records: readonly HubPeerRecord[] = [{ peerId: remote.signer.installationId, url: `ws://127.0.0.1:${peer.port}/fleet-ws`, transportMode: 'ssh-loopback', pinnedPublicKey: remote.publicKey, enrollmentState: 'enrolled' }];
  const registry = new HubPeerConnectionRegistry({ peers: { list: () => records }, local: { signer: hub.signer, processEpoch: randomUUID(), capabilities }, scheduler, random: () => 0.5, dial: dialFleetWebSocket, recordNegotiation: () => undefined, onFrame: () => undefined });
  context.after(async () => { registry.stop(); await peer.stop(); }); const ready = online(registry, remote.signer.installationId); registry.start(); await ready;
  const reconnected = online(registry, remote.signer.installationId); peer.setAfterAction(() => registry.reconnect(remote.signer.installationId)); let unknown: FleetMutationClientError | undefined;
  try { await new FleetMutationClient(registry).sendChat(session(remote.signer.installationId), { requestId: 'unknown-live', deadlineAtMs: Date.now() + 5_000, message: 'once' }); }
  catch (error) { if (error instanceof FleetMutationClientError) unknown = error; else throw error; }
  assert.equal(unknown?.code, 'HOST_COMMAND_OUTCOME_UNKNOWN'); if (unknown?.outcome === null || unknown?.outcome === undefined) throw new TypeError('unknown outcome tracker missing'); assert.equal(unknown.outcome.status, 'unknown');
  await reconnected; const reads = new FleetReadClient(registry); const status = await unknown.outcome.reconcile(async () => { const deadlineAtMs = Date.now() + 2_000; await Promise.all([reads.history(session(remote.signer.installationId), { deadlineAtMs, limit: 20, offset: 0, includeImages: false }), reads.metadata(session(remote.signer.installationId), deadlineAtMs)]); return 'applied'; });
  assert.equal(status, 'resolved_applied'); assert.equal(log.filter((entry) => entry === 'action:send').length, 1); assert.deepEqual(log.slice(-2), ['read:transcript', 'read:discovery']);
});
