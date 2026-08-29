import assert from 'node:assert/strict';
import test from 'node:test';

import { parseFleetRequestEnvelope } from '../../../../shared/fleet.js';
import { createPeerOperationDispatcher } from '../peer/operation-dispatcher.js';
import { createFleetReadHandlers, type FleetReadServices } from '../rpc/reads/peer.js';

const HOST = '123e4567-e89b-42d3-a456-426614174000';
const OTHER = '223e4567-e89b-42d3-a456-426614174000';

function services(label: string, calls: string[]): FleetReadServices {
  return {
    sessionMetadata: async (localId) => { calls.push(`metadata:${localId}`); return { sessionId: localId, summary: label }; },
    history: async (localId) => { calls.push(`history:${localId}`); return { messages: [label] }; },
    search: async (localId, query) => { calls.push(`search:${localId}:${query}`); return { results: [label] }; },
    prompt: async (localId) => { calls.push(`prompt:${localId}`); return { prompt: label }; },
    approval: async (localId) => { calls.push(`approval:${localId}`); return { approval: label }; },
    capturePane: async (target) => { calls.push(`pane:${target.localId}`); return { output: label }; },
    providerInventory: async (localId) => { calls.push(`inventory:${localId}`); return { commands: [{ name: '/go', sourcePath: `/home/${label}/secret.md` }] }; },
    chatSubscription: async (localId, lastSeq) => { calls.push(`subscription:${localId}:${lastSeq}`); return { isProcessing: false, lastSeq, events: [] }; },
    pathSuggestions: async (localId, prefix) => { calls.push(`paths:${localId}:${prefix}`); return { home: `/home/${label}`, suggestions: [`${prefix}-${label}`] }; },
  };
}

function request(hostId: string, operation: 'session.history' | 'session.read', body: Readonly<Record<string, string | number | boolean | null>>) {
  return parseFleetRequestEnvelope({
    kind: 'request', protocolVersion: 'fleet/1', connectionGeneration: 1,
    requestId: `${hostId}-${operation}`, operation,
    target: { kind: 'session', hostId, localId: 'collision' }, body,
  });
}

test('Given collision peers, when reads target one host, then only that peer resolves its local id and responses are redacted', async () => {
  // Given
  const callsA: string[] = []; const callsB: string[] = [];
  const dispatchA = createPeerOperationDispatcher(HOST, createFleetReadHandlers(HOST, services('peer-a', callsA), () => 1_000));
  const dispatchB = createPeerOperationDispatcher(OTHER, createFleetReadHandlers(OTHER, services('peer-b', callsB), () => 1_000));

  // When
  const history = await dispatchA(request(HOST, 'session.history', { deadlineAtMs: 2_000, limit: 20, offset: 0, includeImages: false }));
  const inventory = await dispatchA(request(HOST, 'session.read', { read: 'provider_inventory', deadlineAtMs: 2_000 }));
  const wrong = await dispatchB(request(HOST, 'session.history', { deadlineAtMs: 2_000, limit: 20, offset: 0, includeImages: false }));

  // Then
  assert.deepEqual(history.body, { messages: ['peer-a'] });
  assert.deepEqual(inventory.body, { commands: [{ name: '/go' }] });
  assert.equal(wrong.status, 'failure');
  assert.deepEqual(callsA, ['history:collision', 'inventory:collision']);
  assert.deepEqual(callsB, []);
  assert.doesNotMatch(JSON.stringify(inventory), /home|secret|sourcePath/);
});

test('Given expired and unknown reads, when dispatched, then explicit failures do not close or retarget the peer', async () => {
  // Given
  const calls: string[] = [];
  const missing: FleetReadServices = {
    ...services('peer-a', calls),
    sessionMetadata: async () => null,
  };
  const dispatch = createPeerOperationDispatcher(HOST, createFleetReadHandlers(HOST, missing, () => 3_000));

  // When
  const expired = await dispatch(request(HOST, 'session.history', { deadlineAtMs: 2_000, limit: 20, offset: 0, includeImages: false }));
  const unknown = await dispatch(request(HOST, 'session.read', { read: 'metadata', deadlineAtMs: 4_000 }));

  // Then
  assert.equal(expired.status, 'failure');
  assert.equal(expired.status === 'failure' ? expired.error : null, 'FLEET_DEADLINE_EXCEEDED');
  assert.equal(unknown.status === 'failure' ? unknown.error : null, 'HOST_NOT_FOUND');
  assert.deepEqual(calls, []);
});
