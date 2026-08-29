import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { FLEET_CAPABILITIES } from '../../../../../shared/fleet.js';
import { HubPeerConnectionRegistry } from '../../hub/connection/registry.js';
import type { HubConnectionScheduler, HubPeerRecord, HubPeerStatus } from '../../hub/connection/types.js';
import { dialFleetWebSocket } from '../../hub/connection/websocket-dialer.js';
import { createFleetProof, negotiateFleetChallenge } from '../../protocol/auth.js';
import type { FleetHelloFrame } from '../../protocol/types.js';

import {
  bounded,
  connectAuthenticated,
  createHubHello,
  failureOf,
  HubLink,
  sendRequest,
} from './support/hub-driver.js';
import { assertNoSecretMaterial, createInstallation, type TestInstallation } from './support/identities.js';
import { FIXTURE_SESSION, startPeer } from './support/peer-fixture.js';
import { startRawPeer } from './support/raw-peer.js';
import { armTraceFlush, recordedTraces, recordTrace } from './support/traces.js';

armTraceFlush('task-22-lifecycle-security');

const scheduler: HubConnectionScheduler = {
  get nowMs() { return Date.now(); },
  schedule: (delayMs, callback) => {
    const timer = setTimeout(callback, delayMs);
    timer.unref();
    return { cancel: () => clearTimeout(timer) };
  },
};

function stateSignal(registry: HubPeerConnectionRegistry, peerId: string, state: HubPeerStatus['state']): Promise<HubPeerStatus> {
  const result = Promise.withResolvers<HubPeerStatus>();
  const unsubscribe = registry.subscribe((status) => {
    if (status.peerId === peerId && status.state === state) {
      unsubscribe();
      result.resolve(status);
    }
  });
  return bounded(result.promise, `${peerId} ${state}`);
}

function gate(): Readonly<{ entered: Promise<void>; release: () => void; beforeRead: () => Promise<void> }> {
  const enteredSignal = Promise.withResolvers<void>();
  const releaseSignal = Promise.withResolvers<void>();
  return {
    entered: enteredSignal.promise,
    release: () => releaseSignal.resolve(),
    beforeRead: async () => { enteredSignal.resolve(); await releaseSignal.promise; },
  };
}

test('Given an in-flight mutation, when the hub grant is revoked mid-verification, then the action never runs and re-auth fails', async (context) => {
  // Given
  const hub = createInstallation();
  const aId = createInstallation();
  const authorityGate = gate();
  const a = await startPeer({ identity: aId, hub, gate: authorityGate });
  context.after(async () => { await a.stop(); });
  const session = await connectAuthenticated(a.port, {
    hub, processEpoch: 'hub-epoch-1', capabilities: FLEET_CAPABILITIES,
    peer: { installationId: a.hostId, publicKey: aId.publicKey },
  });
  context.after(async () => { await session.link.close(); });
  const target = { kind: 'session', hostId: a.hostId, localId: FIXTURE_SESSION } as const;
  const body = { deadlineAtMs: 9_000, message: 'revoked-in-flight' };
  const first = sendRequest(session.link, { operation: 'chat.send', target, generation: session.generation, requestId: 'in-flight-1', body });
  await authorityGate.entered;
  const duplicate = sendRequest(session.link, { operation: 'chat.send', target, generation: session.generation, requestId: 'in-flight-1', body });
  // When: the real store revokes the grant while the verifier is blocked.
  assert.equal(a.store.revoke(a.hostId, 2_000), true);
  authorityGate.release();
  // Then: both the original and its ledger duplicate fail explicitly, and no action ran.
  for (const response of [await first, await duplicate]) {
    assert.equal(failureOf(response), 'HOST_REVOKED');
    assert.equal(response.sideEffect, 'none');
  }
  assert.deepEqual(a.chain.actionLog, []);
  assert.deepEqual(a.chain.dispatchLog, ['chat.send']);
  recordTrace({ case: 'live.revocation-in-flight', surface: 'websocket', request: 'chat.send blocked at verifier, grant revoked, released', outcome: 'failure HOST_REVOKED sideEffect=none x2', sideEffects: 'actions=0 dispatch=1' });
  // When: the revoked hub attempts a fresh authentication.
  const denied = await HubLink.open(a.port);
  context.after(async () => { await denied.close(); });
  const deniedClosed = denied.closed();
  denied.send(createHubHello({ hub, processEpoch: 'hub-epoch-1', capabilities: FLEET_CAPABILITIES, peer: { installationId: a.hostId, publicKey: aId.publicKey } }, '4ce8f6a2-9c2f-4d3a-8f1e-2b6d5a9c7e03'));
  // Then: admission fails closed at the trust boundary.
  assert.deepEqual(await deniedClosed, { code: 4003, reason: 'fleet authentication rejected' });
  assert.equal(a.authLog.length, 1);
  recordTrace({ case: 'live.revoked-reauth', surface: 'websocket', request: 'auth.hello from revoked hub', outcome: 'close 4003 fleet authentication rejected', sideEffects: 'authenticated=1(prior) dispatch=0' });
});

test('Given an in-flight mutation, when the persisted generation is superseded mid-verification, then the action never runs', async (context) => {
  // Given
  const hub = createInstallation();
  const bId = createInstallation();
  const authorityGate = gate();
  const b = await startPeer({ identity: bId, hub, gate: authorityGate });
  context.after(async () => { await b.stop(); });
  const session = await connectAuthenticated(b.port, {
    hub, processEpoch: 'hub-epoch-1', capabilities: FLEET_CAPABILITIES,
    peer: { installationId: b.hostId, publicKey: bId.publicKey },
  });
  context.after(async () => { await session.link.close(); });
  const pending = sendRequest(session.link, {
    operation: 'chat.send',
    target: { kind: 'session', hostId: b.hostId, localId: FIXTURE_SESSION },
    generation: session.generation, requestId: 'superseded-1',
    body: { deadlineAtMs: 9_000, message: 'superseded-in-flight' },
  });
  await authorityGate.entered;
  // When: the persisted generation row moves while the verifier is blocked.
  b.db.prepare('UPDATE app_config SET value = ? WHERE key = ?').run('99', `fleet.peer.connection-generation.${b.hostId}`);
  authorityGate.release();
  // Then: the final check fails explicitly and the action never ran.
  const response = await pending;
  assert.equal(failureOf(response), 'FLEET_STALE_GENERATION');
  assert.equal(response.sideEffect, 'none');
  assert.deepEqual(b.chain.actionLog, []);
  recordTrace({ case: 'live.generation-supersede-in-flight', surface: 'websocket', request: 'chat.send blocked at verifier, generation row bumped', outcome: 'failure FLEET_STALE_GENERATION sideEffect=none', sideEffects: 'actions=0 dispatch=1' });
});

test('Given the production hub driver, when the controller restarts with a new epoch, then re-authentication claims a fresh generation', async (context) => {
  // Given
  const hub = createInstallation();
  const aId = createInstallation();
  const a = await startPeer({ identity: aId, hub, processEpoch: 'controller-peer-epoch' });
  context.after(async () => { await a.stop(); });
  const records: readonly HubPeerRecord[] = [{
    peerId: a.hostId, url: `ws://127.0.0.1:${a.port}/fleet-ws`,
    transportMode: 'ssh-loopback', pinnedPublicKey: aId.publicKey, enrollmentState: 'enrolled',
  }];
  const local = (processEpoch: string) => ({ signer: hub.signer, processEpoch, capabilities: ['catalog.read'] as const });
  const options = (processEpoch: string) => ({
    peers: { list: () => records }, local: local(processEpoch), requiredCapabilities: ['catalog.read'] as const,
    scheduler, random: () => 0.5, dial: dialFleetWebSocket,
    recordNegotiation: () => undefined, onFrame: () => undefined,
  });
  const first = new HubPeerConnectionRegistry(options('controller-epoch-1'));
  const onlineFirst = stateSignal(first, a.hostId, 'online');
  first.start();
  await onlineFirst;
  assert.equal(a.generation(), 1);
  // When: the controller process stops and restarts with a new epoch.
  first.stop();
  const second = new HubPeerConnectionRegistry(options('controller-epoch-2'));
  context.after(() => second.stop());
  const onlineSecond = stateSignal(second, a.hostId, 'online');
  second.start();
  const status = await onlineSecond;
  // Then: a fresh generation is claimed through the real handshake and persisted store.
  assert.equal(a.generation(), 2);
  assert.deepEqual(a.authLog, [`${hub.signer.installationId}#1`, `${hub.signer.installationId}#2`]);
  assert.equal(status.peerProcessEpoch, 'controller-peer-epoch');
  assert.equal(second.status(a.hostId)?.generation, 2);
  recordTrace({ case: 'live.controller-restart', surface: 'websocket', request: 'production hub registry stop + restart new epoch', outcome: 'online x2 generations 1 then 2', sideEffects: 'stale-frames=0 wrong-peer=0' });
});

test('Given a restarted peer on the same port, when its persisted identity returns, then old generations stay stale and the new epoch authenticates', async (context) => {
  // Given
  const hub: TestInstallation = createInstallation();
  const aId = createInstallation();
  const directory = mkdtempSync(join(tmpdir(), 'chatmux-fleet-security-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const first = await startPeer({ identity: aId, hub, processEpoch: 'peer-epoch-1', dbFile: join(directory, 'peer.sqlite') });
  const handshake = {
    hub, processEpoch: 'hub-epoch-1', capabilities: FLEET_CAPABILITIES,
    peer: { installationId: first.hostId, publicKey: aId.publicKey },
  } as const;
  const firstLink = await connectAuthenticated(first.port, handshake);
  const firstClosed = firstLink.link.closed();
  // When: the peer process stops and restarts with the same identity and database.
  await first.stop();
  assert.equal((await firstClosed).code, 1006);
  const second = await startPeer({ identity: aId, hub, processEpoch: 'peer-epoch-2', dbFile: join(directory, 'peer.sqlite'), port: first.port });
  context.after(async () => { await second.stop(); });
  const secondLink = await connectAuthenticated(second.port, handshake);
  context.after(async () => { await secondLink.link.close(); });
  // Then: the persisted generation advanced, the current epoch serves, and old-generation frames fail.
  assert.equal(secondLink.generation, 2);
  assert.equal(second.generation(), 2);
  const served = await sendRequest(secondLink.link, {
    operation: 'chat.send',
    target: { kind: 'session', hostId: second.hostId, localId: FIXTURE_SESSION },
    generation: secondLink.generation, requestId: 'restart-current',
    body: { deadlineAtMs: 9_000, message: 'current-after-restart' },
  });
  assert.equal(served.status, 'success');
  assert.equal(second.chain.actionLog.length, 1);
  const staleClosed = secondLink.link.closed();
  secondLink.link.sendRaw(JSON.stringify({
    kind: 'request', protocolVersion: 'fleet/1', connectionGeneration: 1, requestId: 'restart-stale',
    operation: 'chat.send',
    target: { kind: 'session', hostId: second.hostId, localId: FIXTURE_SESSION },
    body: { deadlineAtMs: 9_000, message: 'stale-after-restart' },
  }));
  assert.deepEqual(await staleClosed, { code: 4002, reason: 'fleet protocol rejected' });
  assert.deepEqual(second.chain.dispatchLog, ['chat.send']);
  recordTrace({ case: 'live.peer-restart', surface: 'websocket', request: 'peer restart same identity/port, current + stale generation frames', outcome: 'gen 2 online success x1, stale close 4002', sideEffects: 'dispatch=1(current) actions=1 stale-dispatch=0' });
  await firstLink.link.close();
});

test('Given a blocked writer, when the outbound queue exceeds its bound, then the live socket closes without unbounded buffering', async (context) => {
  // Given
  const hub = createInstallation();
  const aId = createInstallation();
  const raw = await startRawPeer({ identity: aId, hub, writer: { maxFrames: 2, maxBytes: 1_000_000 }, holdSendCallbacks: true });
  context.after(async () => { await raw.stop(); });
  const link = await HubLink.open(raw.port);
  context.after(async () => { await link.close(); });
  // When: the honest handshake fills the bounded writer during activation.
  const closed = link.closed();
  const hello = createHubHello({
    hub, processEpoch: 'hub-epoch-1', capabilities: FLEET_CAPABILITIES,
    peer: { installationId: raw.hostId, publicKey: aId.publicKey },
  }, '4ce8f6a2-9c2f-4d3a-8f1e-2b6d5a9c7e04');
  const peerHello = link.expectFrame((frame): frame is FleetHelloFrame => frame.kind === 'auth.hello', 'raw peer hello');
  link.send(hello);
  const negotiation = negotiateFleetChallenge(hello, await peerHello, raw.hostId);
  link.send(await createFleetProof({ signer: hub.signer, role: 'hub', connectionId: hello.connectionId, challenge: negotiation.challenge }));
  // Then: queue exhaustion closes the socket explicitly before any dispatch.
  assert.equal((await closed).code, 4008);
  assert.deepEqual(raw.errors, ['PROTOCOL_QUEUE_FULL']);
  assert.deepEqual(raw.chain.dispatchLog, []);
  assert.deepEqual(raw.chain.actionLog, []);
  raw.releaseSends();
  recordTrace({ case: 'live.queue-exhaustion', surface: 'websocket', request: 'blocked writer maxFrames=2 during auth activation', outcome: 'close 4008 PROTOCOL_QUEUE_FULL', sideEffects: 'dispatch=0 actions=0 buffered=bounded' });
});

test('Given a full request cache, when a new request ID arrives, then it is denied explicitly while the in-flight request completes', async (context) => {
  // Given
  const hub = createInstallation();
  const aId = createInstallation();
  const authorityGate = gate();
  const raw = await startRawPeer({ identity: aId, hub, requestCapacity: 1, gate: authorityGate });
  context.after(async () => { await raw.stop(); });
  const session = await connectAuthenticated(raw.port, {
    hub, processEpoch: 'hub-epoch-1', capabilities: FLEET_CAPABILITIES,
    peer: { installationId: raw.hostId, publicKey: aId.publicKey },
  });
  context.after(async () => { await session.link.close(); });
  const target = { kind: 'session', hostId: raw.hostId, localId: FIXTURE_SESSION } as const;
  const body = { deadlineAtMs: 9_000, message: 'cache-bounds' };
  const first = sendRequest(session.link, { operation: 'chat.send', target, generation: session.generation, requestId: 'cache-1', body });
  await authorityGate.entered;
  // When: a second request ID arrives while the ledger is full.
  const overflow = await sendRequest(session.link, { operation: 'chat.send', target, generation: session.generation, requestId: 'cache-2', body });
  // Then: the overflow fails explicitly without dispatch, and the original completes.
  assert.equal(failureOf(overflow), 'FLEET_REQUEST_CACHE_FULL');
  assert.equal(overflow.sideEffect, 'none');
  authorityGate.release();
  assert.equal((await first).status, 'success');
  assert.deepEqual(raw.chain.dispatchLog, ['chat.send']);
  assert.equal(raw.chain.actionLog.length, 1);
  recordTrace({ case: 'live.request-cache-bounds', surface: 'websocket', request: 'chat.send cache-2 while cache-1 in flight, capacity=1', outcome: 'failure FLEET_REQUEST_CACHE_FULL then cache-1 success', sideEffects: 'dispatch=1 actions=1' });
});

test('Given the recorded lifecycle denial surface, when it is scanned, then no secret material crosses', () => {
  // Given: every close reason, failure code, and status this file observed.
  const serialized = JSON.stringify(recordedTraces());
  // When: the surface is scanned for secrets and secret shapes.
  assertNoSecretMaterial(serialized, []);
  // Then: only machine outcomes were recorded.
  assert.notEqual(recordedTraces().length, 0);
});
