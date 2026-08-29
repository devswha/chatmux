import assert from 'node:assert/strict';
import test from 'node:test';

import { parseFleetRequestEnvelope, type FleetResponseEnvelope } from '../../../../shared/fleet.js';
import { createPeerOperationDispatcher } from '../peer/operation-dispatcher.js';
import { FleetRequestLedger } from '../protocol/request-ledger.js';

const HOST = '123e4567-e89b-42d3-a456-426614174000';
function mutation(requestId: string, message = 'hello') {
  return parseFleetRequestEnvelope({ kind: 'request', protocolVersion: 'fleet/1', connectionGeneration: 3, requestId, operation: 'chat.send', target: { kind: 'session', hostId: HOST, localId: 'collision' }, body: { deadlineAtMs: 9_000, message } });
}
function success(request: ReturnType<typeof mutation>): FleetResponseEnvelope { return { kind: 'response', protocolVersion: 'fleet/1', connectionGeneration: request.connectionGeneration, requestId: request.requestId, target: request.target, status: 'success', sideEffect: 'applied', body: { ok: true } }; }

test('Given canonical mutation IDs, when duplicate requests are pending or complete, then they coalesce and replay while altered payload conflicts', async () => {
  const ledger = new FleetRequestLedger(); const first = mutation('same-id');
  const admitted = ledger.admit(first); const concurrent = ledger.admit(first); const altered = ledger.admit(mutation('same-id', 'altered'));
  assert.equal(admitted.kind, 'dispatch'); assert.equal(concurrent.kind, 'pending'); assert.equal(altered.kind, 'conflict');
  if (admitted.kind !== 'dispatch' || concurrent.kind !== 'pending') throw new TypeError('ledger admission mismatch');
  admitted.complete(success(first)); assert.deepEqual(await concurrent.response, success(first));
  const replay = ledger.admit(first); assert.equal(replay.kind, 'replay');
});

test('Given the 4096-entry generation cache, when full, then a new ID is rejected but a prior ID still replays', () => {
  const ledger = new FleetRequestLedger(); let firstResponse: FleetResponseEnvelope | undefined;
  for (let index = 0; index < 4_096; index += 1) {
    const request = mutation(`request-${index}`); const admission = ledger.admit(request);
    if (admission.kind !== 'dispatch') throw new TypeError('unexpected ledger admission');
    const response = success(request); admission.complete(response); if (index === 0) firstResponse = response;
  }
  assert.equal(ledger.size, 4_096); assert.equal(ledger.admit(mutation('new-id')).kind, 'full');
  const replay = ledger.admit(mutation('request-0')); assert.equal(replay.kind, 'replay');
  if (replay.kind !== 'replay') throw new TypeError('replay missing'); assert.deepEqual(replay.response, firstResponse);
});

test('Given successful mutation dispatch, when the peer responds, then sideEffect is applied', async () => {
  let calls = 0; const dispatch = createPeerOperationDispatcher(HOST, { 'chat.send': async () => { calls += 1; return { ok: true }; } });
  const response = await dispatch(mutation('applied'));
  assert.equal(calls, 1); assert.equal(response.status, 'success'); assert.equal(response.sideEffect, 'applied');
});
