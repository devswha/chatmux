import assert from 'node:assert/strict';
import test from 'node:test';

import { FleetMutationClientError, FleetUnknownMutationOutcome } from '../rpc/mutations/index.js';

import {
  closeFixture,
  COLLIDING_PROJECT,
  COLLIDING_SESSION,
  errorCode,
  LOCAL_HOST,
  PEER_A,
  PEER_B,
  peerStatus,
  startRoutesFixture,
} from './support/task-16-routes-fixture.js';

test('Given inventory, prompt, approval and suggestion reads, when the local host is addressed, then current local services answer unchanged', async (context) => {
  // Given
  const fixture = await startRoutesFixture(); context.after(() => closeFixture(fixture.server));

  // When
  const inventory = await fetch(`${fixture.baseUrl}/hosts/${LOCAL_HOST}/providers/sessions/${COLLIDING_SESSION}/inventory`);
  const prompt = await fetch(`${fixture.baseUrl}/hosts/${LOCAL_HOST}/providers/sessions/${COLLIDING_SESSION}/prompt`);
  const approval = await fetch(`${fixture.baseUrl}/hosts/${LOCAL_HOST}/providers/sessions/${COLLIDING_SESSION}/approval`);
  const suggestions = await fetch(`${fixture.baseUrl}/hosts/${LOCAL_HOST}/projects/${COLLIDING_PROJECT}/dir-suggestions?prefix=work`);

  // Then
  assert.deepEqual(await inventory.json(), { success: true, data: { provider: 'gjc', commands: [] } });
  assert.deepEqual(await prompt.json(), { success: true, data: { prompt: 'local-prompt' } });
  assert.deepEqual(await approval.json(), { success: true, data: { approval: 'local-approval' } });
  assert.deepEqual(await suggestions.json(), { success: true, data: { suggestions: ['local/work'] } });
  assert.equal(fixture.peerLookups(), 0);
  assert.deepEqual(fixture.calls.map((call) => call.hostId), [LOCAL_HOST, LOCAL_HOST, LOCAL_HOST, LOCAL_HOST]);
});

test('Given two peers holding the same session id, when each host-qualified read runs, then only the addressed peer is called', async (context) => {
  // Given
  const fixture = await startRoutesFixture(); context.after(() => closeFixture(fixture.server));

  // When
  const inventoryA = await fetch(`${fixture.baseUrl}/hosts/${PEER_A}/providers/sessions/${COLLIDING_SESSION}/inventory`);
  const promptB = await fetch(`${fixture.baseUrl}/hosts/${PEER_B}/providers/sessions/${COLLIDING_SESSION}/prompt`);
  const approvalA = await fetch(`${fixture.baseUrl}/hosts/${PEER_A}/providers/sessions/${COLLIDING_SESSION}/approval`);
  const suggestionsB = await fetch(`${fixture.baseUrl}/hosts/${PEER_B}/projects/${COLLIDING_PROJECT}/dir-suggestions?prefix=repo`);

  // Then
  assert.deepEqual(await inventoryA.json(), { success: true, data: { provider: 'codex', commands: [{ name: 'peer-skill', description: '', scope: 'project' }] } });
  assert.deepEqual(await promptB.json(), { success: true, data: { prompt: PEER_B } });
  assert.deepEqual(await approvalA.json(), { success: true, data: { approval: PEER_A } });
  assert.deepEqual(await suggestionsB.json(), { success: true, data: { suggestions: [`${PEER_B}/repo`] } });
  assert.deepEqual(fixture.calls, [
    { hostId: PEER_A, method: 'inventory', localId: COLLIDING_SESSION },
    { hostId: PEER_B, method: 'prompt', localId: COLLIDING_SESSION },
    { hostId: PEER_A, method: 'approval', localId: COLLIDING_SESSION },
    { hostId: PEER_B, method: 'pathSuggestions', localId: COLLIDING_PROJECT },
  ]);
});

test('Given a spawn request, when a peer project is addressed, then only that peer spawns and the peer validates the path', async (context) => {
  // Given
  const fixture = await startRoutesFixture(); context.after(() => closeFixture(fixture.server));

  // When
  const spawned = await fetch(`${fixture.baseUrl}/hosts/${PEER_B}/projects/${COLLIDING_PROJECT}/sessions/spawn`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'peer-b-session', cwd: 'repos/app' }),
  });

  // Then
  assert.equal(spawned.status, 200);
  assert.deepEqual(await spawned.json(), { success: true, data: { ok: true, name: 'peer-b-session', cwd: 'repos/app' } });
  assert.deepEqual(fixture.calls, [{ hostId: PEER_B, method: 'spawn', localId: COLLIDING_PROJECT }]);
});

test('Given an absolute controller path, when a remote spawn is requested, then the request is rejected before any peer call', async (context) => {
  // Given
  const fixture = await startRoutesFixture(); context.after(() => closeFixture(fixture.server));

  // When
  const rejected = await fetch(`${fixture.baseUrl}/hosts/${PEER_A}/projects/${COLLIDING_PROJECT}/sessions/spawn`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'absolute', cwd: '/etc' }),
  });

  // Then
  assert.equal(rejected.status, 400);
  assert.equal(errorCode(await rejected.json()), 'FLEET_MALFORMED_FRAME');
  assert.deepEqual(fixture.calls, []);
});

test('Given a dispatched spawn whose outcome is unknown, when the peer connection drops, then the response is a non-success conflict without retry', async (context) => {
  // Given
  const fixture = await startRoutesFixture(); context.after(() => closeFixture(fixture.server));
  fixture.failNextRemote(new FleetMutationClientError(
    'HOST_COMMAND_OUTCOME_UNKNOWN', 'fleet mutation outcome is unknown', 'possible', new FleetUnknownMutationOutcome('spawn-1'),
  ));

  // When
  const uncertain = await fetch(`${fixture.baseUrl}/hosts/${PEER_A}/projects/${COLLIDING_PROJECT}/sessions/spawn`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'uncertain', cwd: 'repos/app' }),
  });

  // Then
  assert.equal(uncertain.status, 409);
  assert.equal(errorCode(await uncertain.json()), 'HOST_COMMAND_OUTCOME_UNKNOWN');
  assert.deepEqual(fixture.calls, [{ hostId: PEER_A, method: 'spawn', localId: COLLIDING_PROJECT }]);
});

test('Given an unavailable or capability-less peer, when inventory and spawn are requested, then each denial is explicit and reaches no peer service', async (context) => {
  // Given
  const fixture = await startRoutesFixture(); context.after(() => closeFixture(fixture.server));

  // When
  fixture.statuses.set(PEER_A, peerStatus(PEER_A, 'offline'));
  const offline = await fetch(`${fixture.baseUrl}/hosts/${PEER_A}/providers/sessions/${COLLIDING_SESSION}/inventory`);
  fixture.statuses.set(PEER_A, peerStatus(PEER_A, 'syncing'));
  const syncing = await fetch(`${fixture.baseUrl}/hosts/${PEER_A}/providers/sessions/${COLLIDING_SESSION}/prompt`);
  fixture.statuses.set(PEER_A, peerStatus(PEER_A, 'incompatible'));
  const incompatible = await fetch(`${fixture.baseUrl}/hosts/${PEER_A}/projects/${COLLIDING_PROJECT}/dir-suggestions?prefix=`);
  fixture.statuses.set(PEER_A, peerStatus(PEER_A, 'online', ['catalog.read', 'session.read']));
  const withoutCapability = await fetch(`${fixture.baseUrl}/hosts/${PEER_A}/projects/${COLLIDING_PROJECT}/sessions/spawn`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'denied', cwd: 'repos/app' }),
  });
  const nonOwner = await fetch(`${fixture.baseUrl}/hosts/${PEER_B}/providers/sessions/${COLLIDING_SESSION}/inventory`, {
    headers: { 'x-role': 'user' },
  });

  // Then
  assert.deepEqual(
    [offline.status, syncing.status, incompatible.status, withoutCapability.status, nonOwner.status],
    [503, 503, 503, 422, 403],
  );
  assert.deepEqual(
    [errorCode(await offline.json()), errorCode(await syncing.json()), errorCode(await incompatible.json()), errorCode(await withoutCapability.json()), errorCode(await nonOwner.json())],
    ['HOST_OFFLINE', 'HOST_SYNCING', 'HOST_INCOMPATIBLE', 'FLEET_CAPABILITY_UNAVAILABLE', 'FLEET_UNAUTHORIZED'],
  );
  assert.deepEqual(fixture.calls, []);
});
