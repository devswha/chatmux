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

function streamRequest(operation: 'pane.input' | 'catalog.snapshot', requestId: string) {
  const target = operation === 'catalog.snapshot'
    ? { kind: 'host', hostId: HOST }
    : { kind: 'pane', hostId: HOST, localId: 'pane-1', lane: 'external', tmux: { socketPath: '/tmp/tmux-1000/default', sessionId: '$1', windowId: '@1', paneId: '%1' }, process: { pid: 42, startedAtMs: 100 } };
  const body = operation === 'catalog.snapshot'
    ? {}
    : { deadlineAtMs: 9_000, lease: { token: 'lease-token-1234567890', expiresAtMs: 9_000, connectionGeneration: 3 }, streamEpoch: 'epoch-1', data: 'k' };
  return parseFleetRequestEnvelope({ kind: 'request', protocolVersion: 'fleet/1', connectionGeneration: 3, requestId, operation, target, body });
}
function readSuccess(request: ReturnType<typeof streamRequest>): FleetResponseEnvelope { return { kind: 'response', protocolVersion: 'fleet/1', connectionGeneration: request.connectionGeneration, requestId: request.requestId, target: request.target, status: 'success', sideEffect: 'none', body: null }; }

test('Given reads and terminal input, when they complete, then the ledger forgets them and only mutations are retained', async () => {
  const ledger = new FleetRequestLedger();
  const input = streamRequest('pane.input', 'input-1');
  const admitted = ledger.admit(input); const concurrent = ledger.admit(input);
  assert.equal(admitted.kind, 'dispatch'); assert.equal(concurrent.kind, 'pending', 'an in-flight duplicate still coalesces');
  if (admitted.kind !== 'dispatch' || concurrent.kind !== 'pending') throw new TypeError('ledger admission mismatch');
  admitted.complete(readSuccess(input)); assert.deepEqual(await concurrent.response, readSuccess(input));
  assert.equal(ledger.size, 0, 'a completed keystroke leaves no entry behind');
  const again = ledger.admit(input);
  assert.equal(again.kind, 'dispatch', 'the same id dispatches again rather than replaying a stale result');
  if (again.kind === 'dispatch') again.complete(readSuccess(input));
  assert.equal(ledger.size, 0);

  const snapshot = streamRequest('catalog.snapshot', 'read-1');
  const read = ledger.admit(snapshot); if (read.kind !== 'dispatch') throw new TypeError('read admission mismatch');
  read.complete(readSuccess(snapshot)); assert.equal(ledger.size, 0);

  const mutate = mutation('mutation-1'); const write = ledger.admit(mutate); if (write.kind !== 'dispatch') throw new TypeError('mutation admission mismatch');
  write.complete(success(mutate)); assert.equal(ledger.size, 1); assert.equal(ledger.admit(mutate).kind, 'replay');
});

test('Given thousands of keystrokes on one connection, when a mutation follows, then it is still admitted', () => {
  const ledger = new FleetRequestLedger();
  for (let index = 0; index < 5_000; index += 1) {
    const request = streamRequest('pane.input', `key-${index}`); const admission = ledger.admit(request);
    if (admission.kind !== 'dispatch') throw new TypeError(`keystroke ${index} was not admitted`);
    admission.complete(readSuccess(request));
  }
  assert.equal(ledger.size, 0);
  assert.equal(ledger.admit(mutation('after-typing')).kind, 'dispatch');
});
