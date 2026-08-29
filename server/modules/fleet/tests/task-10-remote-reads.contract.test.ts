import assert from 'node:assert/strict';
import test from 'node:test';

import { parseFleetRequestEnvelope } from '../../../../shared/fleet.js';
import {
  parseFleetReadRequest,
  type FleetReadRequest,
} from '../rpc/reads/contracts.js';

const HOST_A = '123e4567-e89b-42d3-a456-426614174000';

function readRequest(
  operation: FleetReadRequest['operation'],
  target: unknown,
  body: Readonly<Record<string, string | number | boolean | null>>,
): FleetReadRequest {
  return parseFleetReadRequest(parseFleetRequestEnvelope({
    kind: 'request', protocolVersion: 'fleet/1', connectionGeneration: 4,
    requestId: `read-${operation}`, operation, target, body,
  }));
}

test('Given each read operation, when its body is parsed, then the closed typed contract retains its exact target and deadline', () => {
  // Given
  const session = { kind: 'session', hostId: HOST_A, localId: 'same-session' };
  const project = { kind: 'project', hostId: HOST_A, localId: 'same-project' };
  const pane = {
    kind: 'pane', hostId: HOST_A, localId: 'same-pane', lane: 'external',
    tmux: { socketPath: '/tmp/peer-a/tmux.sock', sessionId: '$1', windowId: '@1', paneId: '%1' },
    process: { pid: 4101, startedAtMs: 1001 },
  };

  // When
  const requests = [
    readRequest('session.read', session, { read: 'metadata', deadlineAtMs: 9_000 }),
    readRequest('session.read', session, { read: 'provider_inventory', deadlineAtMs: 9_000 }),
    readRequest('session.history', session, { deadlineAtMs: 9_000, limit: 20, offset: 0, includeImages: false }),
    readRequest('session.search', project, { read: 'transcript_search', deadlineAtMs: 9_000, query: 'needle', limit: 20 }),
    readRequest('session.search', project, { read: 'path_suggestions', deadlineAtMs: 9_000, prefix: 'work' }),
    readRequest('prompt.read', session, { deadlineAtMs: 9_000 }),
    readRequest('approval.read', session, { deadlineAtMs: 9_000 }),
    readRequest('pane.capture', pane, { deadlineAtMs: 9_000 }),
  ];

  // Then
  assert.deepEqual(requests.map((request) => request.body.deadlineAtMs), Array(8).fill(9_000));
  assert.deepEqual(requests.map((request) => request.target.hostId), Array(8).fill(HOST_A));
});

test('Given malformed or controller-local read details, when parsed, then they are refused at the peer boundary', () => {
  // Given
  const session = { kind: 'session', hostId: HOST_A, localId: 'same-session' };
  const malformed = [
    { operation: 'session.read', target: session, body: { read: 'metadata' } },
    { operation: 'session.read', target: session, body: { read: 'provider_inventory', deadlineAtMs: 9_000, provider: 'codex' } },
    { operation: 'session.history', target: session, body: { deadlineAtMs: 9_000, path: '/controller/private' } },
    { operation: 'session.search', target: { kind: 'project', hostId: HOST_A, localId: 'same-project' }, body: { read: 'path_suggestions', deadlineAtMs: 9_000, prefix: '/etc' } },
  ];

  // When / Then
  for (const value of malformed) {
    assert.throws(() => parseFleetReadRequest(parseFleetRequestEnvelope({
      kind: 'request', protocolVersion: 'fleet/1', connectionGeneration: 4,
      requestId: 'malformed-read', ...value,
    })));
  }
});
