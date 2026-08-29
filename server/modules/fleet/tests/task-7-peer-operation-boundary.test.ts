import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FLEET_OPERATIONS,
  parseFleetRequestEnvelope,
  type FleetOperation,
} from '../../../../shared/fleet.js';
import {
  createPeerOperationDispatcher,
  derivePeerCapabilities,
  type PeerOperationHandlers,
} from '../peer/operation-dispatcher.js';

const HOST_ID = '123e4567-e89b-42d3-a456-426614174000';

function request(operation: FleetOperation, body: Readonly<Record<string, string>> = {}) {
  const target = operation === 'catalog.snapshot'
    ? { kind: 'host', hostId: HOST_ID }
    : { kind: 'session', hostId: HOST_ID, localId: 'session-1' };
  return parseFleetRequestEnvelope({
    kind: 'request', protocolVersion: 'fleet/1', connectionGeneration: 1,
    requestId: `request-${operation}`, operation, target, body,
  });
}

test('Given the peer boundary, when its operation surface is enumerated, then it exactly matches the RFC union', () => {
  const expected: readonly FleetOperation[] = [
    'catalog.snapshot', 'session.read', 'session.history', 'session.search',
    'chat.send', 'chat.abort', 'prompt.read', 'prompt.respond', 'approval.read',
    'approval.respond', 'pane.capture', 'pane.attach', 'pane.input', 'pane.resize',
    'pane.interrupt', 'pane.escape', 'pane.terminate', 'process.terminate',
    'session.spawn', 'session.terminate',
  ];

  assert.deepEqual(FLEET_OPERATIONS, expected);
});

test('Given local services, when capabilities are derived, then only complete available operation groups are advertised', () => {
  const handlers: PeerOperationHandlers = {
    'catalog.snapshot': async () => null,
    'session.read': async () => null,
    'session.history': async () => null,
  };

  assert.deepEqual(derivePeerCapabilities(handlers, ['completion.ready']), [
    'catalog.read',
    'completion.event',
  ]);
});

test('Given a typed local handler, when path or argv payloads arrive, then rejection occurs before the service call', async () => {
  let calls = 0;
  const dispatch = createPeerOperationDispatcher(HOST_ID, {
    'catalog.snapshot': async () => { calls += 1; return { snapshot: true }; },
  });

  const pathResult = await dispatch(request('catalog.snapshot', { path: '/private' }));
  const argvResult = await dispatch(request('catalog.snapshot', { argv: '--dangerous' }));

  assert.equal(pathResult.status, 'failure');
  assert.equal(argvResult.status, 'failure');
  assert.equal(calls, 0);
});

test('Given a request for another host, when dispatch runs, then no local service is reached', async () => {
  let calls = 0;
  const dispatch = createPeerOperationDispatcher(HOST_ID, {
    'catalog.snapshot': async () => { calls += 1; return null; },
  });
  const foreign = parseFleetRequestEnvelope({
    kind: 'request', protocolVersion: 'fleet/1', connectionGeneration: 1,
    requestId: 'foreign-host', operation: 'catalog.snapshot',
    target: { kind: 'host', hostId: '223e4567-e89b-42d3-a456-426614174000' }, body: {},
  });

  const result = await dispatch(foreign);

  assert.equal(result.status, 'failure');
  assert.equal(calls, 0);
});

test('Given a handler raising a local AppError, when dispatched, then the failure is typed and the connection survives', async () => {
  // Given: a dispatcher whose handler surfaces a stale local prompt and an invalid local decision.
  const { AppError } = await import('@/shared/utils.js');
  const handlers: PeerOperationHandlers = {
    'approval.respond': async () => {
      throw new AppError('The approval prompt is no longer visible.', { code: 'TMUX_APPROVAL_STALE', statusCode: 409 });
    },
    'prompt.respond': async () => {
      throw new AppError('A choice number is outside the displayed range.', { code: 'TMUX_INTERACTIVE_PROMPT_CHOICE_INVALID', statusCode: 400 });
    },
  };
  const dispatch = createPeerOperationDispatcher(HOST_ID, handlers);
  // When: both local failures cross the boundary.
  const stale = await dispatch(request('approval.respond'));
  const invalid = await dispatch(request('prompt.respond'));
  // Then: each is an explicit typed failure response, never a connection-level throw.
  assert.equal(stale.status, 'failure');
  assert.equal(stale.status === 'failure' ? stale.error : null, 'FLEET_STALE_GENERATION');
  assert.equal(stale.sideEffect, 'none');
  assert.equal(invalid.status, 'failure');
  assert.equal(invalid.status === 'failure' ? invalid.error : null, 'FLEET_MALFORMED_FRAME');
  assert.equal(invalid.sideEffect, 'none');
});
