import assert from 'node:assert/strict';
import test, { before } from 'node:test';

import { getConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import {
  assertFreshExternalTmuxTarget, assertLineageTmuxTarget,
  type DiscoveryCollector, type DiscoveryRow, type ExternalCliSession,
} from '@/modules/providers/index.js';

import type { FleetRequestEnvelope } from '../../../../shared/fleet.js';
import { fleetCatalogPaneKey } from '../catalog/keys.js';
import { createPeerOperationDispatcher } from '../peer/operation-dispatcher.js';
import { createLocalFleetMutationServices } from '../rpc/mutations/local-services.js';
import { createFleetMutationHandlers } from '../rpc/mutations/peer.js';

const HOST = '123e4567-e89b-42d3-a456-426614174000';
const tmux = { socketPath: '/tmp/binding-fixture.sock', sessionId: '$1', windowId: '@1', paneId: '%1' };
const generation = { pid: 4242, startedAtMs: 1234 };
const unproven = [null, undefined, 'inferred', 'unknown', '', 'TAGGED', true, {}, ['observed']];
type SessionRequest = Extract<FleetRequestEnvelope, { target: { kind: 'session' } }>;
before(async () => { await initializeDatabase(); });

function fixture(provider: 'codex' | 'gjc') {
  const nativeId = `native-${provider}`;
  const sessionId = sessionsDb.createSession(nativeId, provider, '/tmp', 'Binding fixture');
  const state = { binding: 'tagged' as unknown, freshKind: provider, freshId: nativeId, effects: 0, verifies: 0, finalChecks: 0 };
  const row: DiscoveryRow = {
    key: 'fixture-row', lane: provider === 'gjc' ? 'live' : 'external', tmuxName: 'fixture',
    tmux, process: generation, kind: provider, providerSessionId: nativeId, binding: 'tagged',
    activity: 'unknown', cwd: '/tmp', lastSeenRevision: 1, presence: 'present', staleSinceRevision: null,
  };
  let rows = [row];
  const discovery = {
    ensureFresh: async () => {}, currentSnapshot: () => ({ rows }),
  } as unknown as DiscoveryCollector;
  const services = createLocalFleetMutationServices(HOST, discovery, getConnection(), {
    verifyRow: async () => {
      state.verifies += 1;
      // Exercise the production target verifiers with synthetic discovery evidence.
      const binding = state.binding as NonNullable<ExternalCliSession['binding']>;
      return state.freshKind === 'gjc'
        ? assertLineageTmuxTarget(tmux, generation, async () => [{
            id: state.freshId, tmuxName: 'fixture', tmux, process: generation,
            claim: 'lineage', binding, kind: 'interactive', model: null, effort: null, running: false,
          }], async () => {})
        : assertFreshExternalTmuxTarget(tmux, generation, {
            scan: async () => [{ tmuxName: 'fixture', tmux, kind: 'codex', providerSessionId: state.freshId,
              binding, agentPid: generation.pid, startedAtMs: generation.startedAtMs }],
            assertPaneIdentity: async () => {},
          });
    },
  });
  const action = async () => { state.effects += 1; };
  const dispatch = createPeerOperationDispatcher(HOST, createFleetMutationHandlers(HOST, {
    ...services,
    finalCheck: async () => { state.finalChecks += 1; },
    send: action, abort: action, respondApproval: action,
    respondPrompt: async () => { await action(); return { action: 'selected' }; },
  }, () => 1000));
  const request = (operation: SessionRequest['operation'], body: FleetRequestEnvelope['body']): SessionRequest => ({
    kind: 'request', protocolVersion: 'fleet/1', connectionGeneration: 7, requestId: `binding-${operation}`,
    operation, target: { kind: 'session', hostId: HOST, localId: sessionId }, body,
  });
  return { row, state, request, dispatch, setRows: (value: DiscoveryRow[]) => { rows = value; } };
}

for (const provider of ['codex', 'gjc'] as const) {
  test(`${provider} fleet session mutations require fresh positive binding before every side effect`, async () => {
    const f = fixture(provider);
    const operations = [
      f.request('chat.send', { deadlineAtMs: 9000, message: 'fixture' }),
      f.request('chat.abort', { deadlineAtMs: 9000 }),
      f.request('prompt.respond', { deadlineAtMs: 9000, response: 'choices', promptId: '0123456789abcdef0123456789abcdef', choices: [1] }),
      f.request('approval.respond', { deadlineAtMs: 9000, decision: 'approve-once' }),
    ];
    for (const binding of unproven) {
      f.state.binding = binding;
      for (const request of operations) {
        const result = await f.dispatch(request);
        assert.equal(result.status, 'failure');
        assert.equal(result.sideEffect, 'none');
        if (result.status === 'failure') assert.equal(result.error, 'FLEET_CAPABILITY_UNAVAILABLE');
      }
    }
    assert.equal(f.state.effects, 0);
    assert.equal(f.state.finalChecks, 0, 'refuse unproven mapping before authorizing any mutation');
    assert.equal(f.state.verifies, unproven.length * operations.length, 'cached tagged row cannot replace fresh proof');

    // Even a missing display grade may be replaced by real fresh proof, never by guesswork.
    f.setRows([{ ...f.row, binding: undefined }]);
    for (const binding of ['tagged', 'observed']) {
      f.state.binding = binding;
      for (const request of operations) {
        const result = await f.dispatch(request);
        assert.equal(result.status, 'success');
        assert.equal(result.sideEffect, 'applied');
      }
    }
    assert.equal(f.state.effects, operations.length * 2);
  });
}

test('fleet session writes reject provider/session changes between discovery and fresh verification', async () => {
  for (const change of ['provider', 'session'] as const) {
    const f = fixture('codex');
    if (change === 'provider') f.state.freshKind = 'gjc';
    else f.state.freshId = 'replacement-session';
    const result = await f.dispatch(f.request('chat.send', { deadlineAtMs: 9000, message: 'never' }));
    assert.equal(result.status, 'failure');
    assert.equal(result.sideEffect, 'none');
    if (result.status === 'failure') assert.equal(result.error, 'FLEET_STALE_GENERATION');
    assert.equal(f.state.effects, 0);
  }
});

test('fleet refuses provider collisions, ambiguous panes, and missing native identities before dispatch', async () => {
  for (const change of ['wrong-provider', 'duplicate', 'missing-native'] as const) {
    const f = fixture('gjc');
    const request = f.request('chat.send', { deadlineAtMs: 9000, message: 'never' });
    if (change === 'wrong-provider') f.setRows([{ ...f.row, kind: 'codex', lane: 'external' }]);
    if (change === 'duplicate') f.setRows([f.row, { ...f.row, tmux: { ...tmux, paneId: '%2' } }]);
    if (change === 'missing-native') {
      getConnection().prepare('UPDATE sessions SET provider_session_id = NULL WHERE session_id = ?').run(request.target.localId);
    }
    const result = await f.dispatch(request);
    assert.equal(result.status, 'failure');
    assert.equal(result.sideEffect, 'none');
    assert.equal(f.state.verifies, 0);
    assert.equal(f.state.effects, 0);
  }
});

test('fleet exact-pane input remains independent of transcript proof but refuses a stale pane generation', async () => {
  const f = fixture('gjc');
  f.state.binding = null;
  const target = {
    kind: 'pane', hostId: HOST, localId: fleetCatalogPaneKey('live', tmux), lane: 'live', tmux, process: generation,
  } as const;
  const request = {
    ...f.request('chat.send', { deadlineAtMs: 9000, message: 'fixture pane' }), operation: 'pane.input' as const, target,
  } satisfies FleetRequestEnvelope;
  assert.equal((await f.dispatch(request)).status, 'success');
  assert.equal(f.state.effects, 1);
  const stale = await f.dispatch({ ...request, target: { ...target, process: { ...generation, startedAtMs: 9999 } } });
  assert.equal(stale.status, 'failure');
  assert.equal(stale.sideEffect, 'none');
  assert.equal(f.state.effects, 1, 'stale exact-pane input must not execute');
});
