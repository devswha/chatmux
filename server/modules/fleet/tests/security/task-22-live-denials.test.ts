import assert from 'node:assert/strict';
import test from 'node:test';

import { FLEET_CAPABILITIES } from '../../../../../shared/fleet.js';
import { createFleetProof, negotiateFleetChallenge } from '../../protocol/auth.js';
import { FLEET_MAX_FRAME_BYTES } from '../../protocol/codec.js';
import type { FleetHeartbeatFrame, FleetHelloFrame, FleetProofFrame } from '../../protocol/types.js';

import {
  authenticateLink,
  connectAuthenticated,
  createHubHello,
  failureOf,
  HubLink,
  sendRequest,
  type HandshakeOptions,
} from './support/hub-driver.js';
import { assertNoSecretMaterial, createInstallation, type TestInstallation } from './support/identities.js';
import { FIXTURE_SESSION, startPeer, type StartedPeer } from './support/peer-fixture.js';
import { armTraceFlush, recordedTraces, recordTrace } from './support/traces.js';

armTraceFlush('task-22-live-denials');

type PeerWorld = Readonly<{
  hub: TestInstallation;
  aId: TestInstallation;
  bId: TestInstallation;
  a: StartedPeer;
  b: StartedPeer;
  handshakeA: HandshakeOptions;
  handshakeB: HandshakeOptions;
}>;

async function startWorld(context: test.TestContext): Promise<PeerWorld> {
  const hub = createInstallation();
  const aId = createInstallation();
  const bId = createInstallation();
  const a = await startPeer({ identity: aId, hub, processEpoch: 'peer-a-epoch' });
  const b = await startPeer({ identity: bId, hub, processEpoch: 'peer-b-epoch' });
  context.after(async () => { await Promise.all([a.stop(), b.stop()]); });
  const base = { hub, processEpoch: 'hub-epoch-1', capabilities: FLEET_CAPABILITIES } as const;
  return {
    hub, aId, bId, a, b,
    handshakeA: { ...base, peer: { installationId: a.hostId, publicKey: aId.publicKey } },
    handshakeB: { ...base, peer: { installationId: b.hostId, publicKey: bId.publicKey } },
  };
}

test('Given two live authenticated peers, when a request names the wrong host, then denial is explicit and isolation holds', async (context) => {
  // Given
  const world = await startWorld(context);
  const linkA = await connectAuthenticated(world.a.port, world.handshakeA);
  const linkB = await connectAuthenticated(world.b.port, world.handshakeB);
  context.after(async () => { await Promise.all([linkA.link.close(), linkB.link.close()]); });
  // When: a chat.send addressed to peer B crosses peer A's real dispatcher.
  const foreign = await sendRequest(linkA.link, {
    operation: 'chat.send',
    target: { kind: 'session', hostId: world.b.hostId, localId: FIXTURE_SESSION },
    generation: linkA.generation, requestId: 'cross-host-1',
    body: { deadlineAtMs: 9_000, message: 'must-not-send' },
  });
  // Then: explicit failure, connection stays usable, and neither peer mutates.
  assert.equal(failureOf(foreign), 'HOST_NOT_FOUND');
  assert.equal(foreign.sideEffect, 'none');
  const sameId = [
    sendRequest(linkA.link, { operation: 'chat.send', target: { kind: 'session', hostId: world.a.hostId, localId: FIXTURE_SESSION }, generation: linkA.generation, requestId: 'shared-id', body: { deadlineAtMs: 9_000, message: 'to-a' } }),
    sendRequest(linkB.link, { operation: 'chat.send', target: { kind: 'session', hostId: world.b.hostId, localId: FIXTURE_SESSION }, generation: linkB.generation, requestId: 'shared-id', body: { deadlineAtMs: 9_000, message: 'to-b' } }),
  ];
  const [responseA, responseB] = await Promise.all(sameId);
  assert.equal(responseA.status, 'success');
  assert.equal(responseB.status, 'success');
  assert.equal(responseA.target.kind === 'session' ? responseA.target.hostId : '', world.a.hostId);
  assert.equal(responseB.target.kind === 'session' ? responseB.target.hostId : '', world.b.hostId);
  assert.deepEqual(world.a.chain.actionLog, [{ operation: 'send', target: 'fixture-verified' }]);
  assert.deepEqual(world.b.chain.actionLog, [{ operation: 'send', target: 'fixture-verified' }]);
  assert.deepEqual(world.b.chain.dispatchLog, ['chat.send']);
  recordTrace({ case: 'live.cross-host-confusion', surface: 'websocket', request: 'chat.send hostId=B on peer A socket', outcome: 'failure HOST_NOT_FOUND sideEffect=none', sideEffects: 'A.actions=1(own) B.actions=1(own) B.foreign=0' });
});

test('Given a live peer, when requests or a captured proof replay, then each replay fails or dedupes without re-dispatch', async (context) => {
  // Given
  const world = await startWorld(context);
  const link = await HubLink.open(world.a.port);
  context.after(async () => { await link.close(); });
  const connectionId = '4ce8f6a2-9c2f-4d3a-8f1e-2b6d5a9c7e01';
  const hello = createHubHello(world.handshakeA, connectionId);
  const peerHello = link.expectFrame((frame): frame is FleetHelloFrame => frame.kind === 'auth.hello', 'peer hello');
  const peerProof = link.expectFrame((frame): frame is FleetProofFrame => frame.kind === 'auth.proof', 'peer proof');
  link.send(hello);
  const negotiation = negotiateFleetChallenge(hello, await peerHello, world.a.hostId);
  const heartbeat = link.expectFrame((frame): frame is FleetHeartbeatFrame => frame.kind === 'heartbeat', 'first heartbeat');
  const proof = await createFleetProof({ signer: world.hub.signer, role: 'hub', connectionId, challenge: negotiation.challenge });
  link.send(proof);
  const generation = (await heartbeat).connectionGeneration;
  await peerProof;
  // When: one request, its exact replay, and an altered replay arrive.
  const body = { deadlineAtMs: 9_000, message: 'replay-me' };
  const target = { kind: 'session', hostId: world.a.hostId, localId: FIXTURE_SESSION } as const;
  const first = await sendRequest(link, { operation: 'chat.send', target, generation, requestId: 'replay-1', body });
  const replayed = await sendRequest(link, { operation: 'chat.send', target, generation, requestId: 'replay-1', body });
  const conflict = await sendRequest(link, { operation: 'chat.send', target, generation, requestId: 'replay-1', body: { deadlineAtMs: 9_000, message: 'altered' } });
  // Then: one dispatch, one replayed response, one explicit conflict.
  assert.equal(first.status, 'success');
  assert.equal(replayed.status, 'success');
  assert.equal(failureOf(conflict), 'FLEET_DUPLICATE_REQUEST_CONFLICT');
  assert.deepEqual(world.a.chain.dispatchLog, ['chat.send']);
  assert.equal(world.a.chain.actionLog.length, 1);
  recordTrace({ case: 'live.request-replay', surface: 'websocket', request: 'chat.send replay-1 x3 (same, same, altered)', outcome: 'success x2 then FLEET_DUPLICATE_REQUEST_CONFLICT', sideEffects: 'dispatch=1 actions=1' });
  // When: the captured hello and proof replay verbatim on a fresh socket.
  const replaySocket = await HubLink.open(world.a.port);
  context.after(async () => { await replaySocket.close(); });
  const replayClosed = replaySocket.closed();
  replaySocket.send(hello);
  await replaySocket.expectFrame((frame): frame is FleetProofFrame => frame.kind === 'auth.proof', 'replayed peer proof');
  replaySocket.send(proof);
  // Then: authentication fails closed before any dispatch.
  assert.deepEqual(await replayClosed, { code: 4003, reason: 'fleet authentication rejected' });
  assert.deepEqual(world.a.chain.dispatchLog, ['chat.send']);
  recordTrace({ case: 'live.auth-proof-replay', surface: 'websocket', request: 'captured auth.hello + auth.proof on new socket', outcome: 'close 4003 fleet authentication rejected', sideEffects: 'dispatch=0(new) actions=1' });
});

test('Given a superseded connection, when stale generations arrive, then the socket closes and dispatch stays zero', async (context) => {
  // Given
  const world = await startWorld(context);
  const first = await connectAuthenticated(world.a.port, world.handshakeA);
  context.after(async () => { await first.link.close(); });
  assert.equal(first.generation, 1);
  const firstClosed = first.link.closed();
  // When: a second controller connection activates, then a stale generation frame arrives.
  const second = await connectAuthenticated(world.a.port, world.handshakeA);
  context.after(async () => { await second.link.close(); });
  assert.equal(second.generation, 2);
  assert.deepEqual(await firstClosed, { code: 4001, reason: 'fleet connection superseded' });
  const staleClosed = second.link.closed();
  second.link.sendRaw(JSON.stringify({
    kind: 'request', protocolVersion: 'fleet/1', connectionGeneration: 1, requestId: 'stale-1',
    operation: 'chat.send',
    target: { kind: 'session', hostId: world.a.hostId, localId: FIXTURE_SESSION },
    body: { deadlineAtMs: 9_000, message: 'stale' },
  }));
  // Then: the stale frame fails closed before dispatch.
  assert.deepEqual(await staleClosed, { code: 4002, reason: 'fleet protocol rejected' });
  assert.deepEqual(world.a.chain.dispatchLog, []);
  assert.deepEqual(world.a.chain.actionLog, []);
  recordTrace({ case: 'live.stale-generation', surface: 'websocket', request: 'chat.send connectionGeneration=1 after supersede to 2', outcome: 'old socket close 4001, stale frame close 4002 fleet protocol rejected', sideEffects: 'dispatch=0 actions=0' });
});

test('Given substituted keys on either side, when authentication runs, then both directions fail closed before dispatch', async (context) => {
  // Given
  const world = await startWorld(context);
  // When: a hub with the pinned installation ID but a fresh keypair authenticates.
  const rogueHub = createInstallation(world.hub.signer.installationId);
  const rogueHubLink = await HubLink.open(world.a.port);
  context.after(async () => { await rogueHubLink.close(); });
  const rogueClosed = rogueHubLink.closed();
  const rogueHello = createHubHello({ ...world.handshakeA, hub: rogueHub }, '4ce8f6a2-9c2f-4d3a-8f1e-2b6d5a9c7e02');
  rogueHubLink.send(rogueHello);
  const peerHello = await rogueHubLink.expectFrame((frame): frame is FleetHelloFrame => frame.kind === 'auth.hello', 'peer hello for rogue hub');
  const negotiation = negotiateFleetChallenge(rogueHello, peerHello, world.a.hostId);
  rogueHubLink.send(await createFleetProof({ signer: rogueHub.signer, role: 'hub', connectionId: rogueHello.connectionId, challenge: negotiation.challenge }));
  // Then: the pinned key rejects the impostor proof.
  assert.deepEqual(await rogueClosed, { code: 4003, reason: 'fleet authentication rejected' });
  assert.deepEqual(world.a.chain.dispatchLog, []);
  recordTrace({ case: 'live.hub-key-substitution', surface: 'websocket', request: 'auth.proof signed by unpinned hub key', outcome: 'close 4003 fleet authentication rejected', sideEffects: 'dispatch=0 actions=0' });
  // When: a peer with the pinned installation ID but a fresh keypair answers.
  const roguePeerId = createInstallation(world.a.hostId);
  const roguePeer = await startPeer({ identity: roguePeerId, hub: world.hub, processEpoch: 'rogue-peer-epoch' });
  context.after(async () => { await roguePeer.stop(); });
  // Then: the controller-side verifier rejects the substituted peer key.
  const rogueLink = await HubLink.open(roguePeer.port);
  context.after(async () => { await rogueLink.close(); });
  await assert.rejects(authenticateLink(rogueLink, world.handshakeA), /proof is invalid/);
  assert.deepEqual(roguePeer.chain.actionLog, []);
  recordTrace({ case: 'live.peer-key-substitution', surface: 'websocket', request: 'auth.proof from re-keyed pinned peer', outcome: 'controller verifier rejects AUTH_SIGNATURE_INVALID', sideEffects: 'dispatch=0 actions=0' });
});

test('Given browser upgrade metadata, when the fleet endpoint is dialed, then the upgrade is rejected before authentication', async (context) => {
  // Given
  const world = await startWorld(context);
  // When: origin, cookie, authorization, and query credentials arrive on upgrade.
  const origin = await HubLink.rejected(world.a.port, { origin: 'https://attacker.example' });
  const cookie = await HubLink.rejected(world.a.port, { cookie: 'chatmux_auth=browser-secret' });
  const bearer = await HubLink.rejected(world.a.port, { authorization: 'Bearer browser-secret' });
  // Then: HTTP 400 precedes any fleet frame and nothing authenticates.
  assert.deepEqual([origin, cookie, bearer], [400, 400, 400]);
  assert.deepEqual(world.a.authLog, []);
  assert.deepEqual(world.a.chain.dispatchLog, []);
  recordTrace({ case: 'live.upgrade-credential-channel', surface: 'websocket', request: 'GET /fleet-ws with origin/cookie/authorization', outcome: 'HTTP 400 x3 pre-auth', sideEffects: 'authenticated=0 dispatch=0' });
});

test('Given an authenticated link, when oversized or malformed frames arrive, then the socket closes and dispatch stays zero', async (context) => {
  // Given
  const world = await startWorld(context);
  const rejected = { code: 4002, reason: 'fleet protocol rejected' };
  // An oversized message never reaches the codec: ws enforces the frame bound
  // before assembly and closes with its own status, so nothing past 64 KiB is
  // ever buffered for an authenticated peer either.
  const tooLarge = { code: 1009, reason: 'Max payload size exceeded' };
  const cases: ReadonlyArray<Readonly<{ name: string; payload: (generation: number) => string | Buffer; close: typeof rejected }>> = [
    { name: 'oversized', payload: () => Buffer.alloc(FLEET_MAX_FRAME_BYTES + 1), close: tooLarge },
    { name: 'not-json', payload: () => 'this-is-not-json{', close: rejected },
    { name: 'unknown-kind', payload: () => JSON.stringify({ kind: 'mystery' }), close: rejected },
    { name: 'extra-field', payload: (generation) => JSON.stringify({ kind: 'request', protocolVersion: 'fleet/1', connectionGeneration: generation, requestId: 'x', operation: 'catalog.snapshot', target: { kind: 'host', hostId: world.a.hostId }, body: null, extra: true }), close: rejected },
  ];
  for (const entry of cases) {
    // When: each hostile frame crosses an authenticated real socket.
    const session = await connectAuthenticated(world.a.port, world.handshakeA);
    context.after(async () => { await session.link.close(); });
    const closed = session.link.closed();
    session.link.sendRaw(entry.payload(session.generation));
    // Then: the connection fails closed with the redacted reason.
    assert.deepEqual(await closed, entry.close, entry.name);
  }
  assert.deepEqual(world.a.chain.dispatchLog, []);
  assert.deepEqual(world.a.chain.actionLog, []);
  recordTrace({ case: 'live.oversized-malformed-frames', surface: 'websocket', request: 'oversized/not-json/unknown-kind/extra-field frames', outcome: 'close 1009 max payload (oversized) + close 4002 fleet protocol rejected x3', sideEffects: 'dispatch=0 actions=0' });
});

test('Given a catalog-only peer, when a chat mutation arrives, then capability denial precedes dispatch', async (context) => {
  // Given
  const hub = createInstallation();
  const cId = createInstallation();
  const catalog = await startPeer({ identity: cId, hub, operations: 'catalog', processEpoch: 'peer-c-epoch' });
  context.after(async () => { await catalog.stop(); });
  assert.deepEqual(catalog.chain.capabilities, ['catalog.read']);
  const link = await connectAuthenticated(catalog.port, {
    hub, processEpoch: 'hub-epoch-1', capabilities: FLEET_CAPABILITIES,
    peer: { installationId: catalog.hostId, publicKey: cId.publicKey },
  });
  context.after(async () => { await link.link.close(); });
  // When: a chat.send arrives outside the negotiated intersection.
  const closed = link.link.closed();
  link.link.sendRaw(JSON.stringify({
    kind: 'request', protocolVersion: 'fleet/1', connectionGeneration: link.generation, requestId: 'denied-1',
    operation: 'chat.send',
    target: { kind: 'session', hostId: catalog.hostId, localId: FIXTURE_SESSION },
    body: { deadlineAtMs: 9_000, message: 'denied' },
  }));
  // Then: the connection fails closed and the dispatcher never runs.
  assert.deepEqual(await closed, { code: 4002, reason: 'fleet protocol rejected' });
  assert.deepEqual(catalog.chain.dispatchLog, []);
  assert.deepEqual(catalog.chain.actionLog, []);
  recordTrace({ case: 'live.capability-denial', surface: 'websocket', request: 'chat.send on catalog.read-only link', outcome: 'close 4002 fleet protocol rejected', sideEffects: 'dispatch=0 actions=0' });
});

test('Given a live read, when the provider inventory crosses the boundary, then sensitive fields are redacted on the wire', async (context) => {
  // Given
  const world = await startWorld(context);
  const session = await connectAuthenticated(world.a.port, world.handshakeA);
  context.after(async () => { await session.link.close(); });
  // When: a provider inventory read crosses the real read handlers and redactor.
  const response = await sendRequest(session.link, {
    operation: 'session.read',
    target: { kind: 'session', hostId: world.a.hostId, localId: FIXTURE_SESSION },
    generation: session.generation, requestId: 'redaction-1',
    body: { read: 'provider_inventory', deadlineAtMs: 9_000 },
  });
  // Then: the visible fields survive and every sensitive field is absent on the wire.
  assert.equal(response.status, 'success');
  const wire = JSON.stringify(response.body);
  assert.match(wire, /visible/);
  assert.doesNotMatch(wire, /secret/);
  assert.deepEqual(world.a.chain.readLog, ['providerInventory']);
  recordTrace({ case: 'live.read-redaction', surface: 'websocket', request: 'session.read provider_inventory', outcome: 'success body redacted to visible fields', sideEffects: 'read=1 actions=0 secret-fields=0' });
});

test('Given the recorded live denial surface, when it is scanned, then no secret material crosses', () => {
  // Given: every close reason and failure code this file observed.
  const serialized = JSON.stringify(recordedTraces());
  // When: the surface is scanned for secrets and secret shapes.
  assertNoSecretMaterial(serialized, []);
  // Then: only machine outcomes were recorded.
  assert.notEqual(recordedTraces().length, 0);
});
