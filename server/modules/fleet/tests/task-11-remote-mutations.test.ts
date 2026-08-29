import assert from 'node:assert/strict';
import test from 'node:test';

import type { FleetRequestEnvelope, FleetSessionReference } from '../../../../shared/fleet.js';
import type { FleetProtocolFrame } from '../protocol/types.js';
import type { HubPeerStatus } from '../hub/connection/types.js';
import { createPeerOperationDispatcher } from '../peer/operation-dispatcher.js';
import { FleetMutationClient, FleetMutationClientError, FleetMutationRpcError, createFleetMutationHandlers, parseFleetMutationRequest, type FleetMutationChannel, type FleetMutationServices, type MutationActionTarget } from '../rpc/mutations/index.js';
const HOST = '123e4567-e89b-42d3-a456-426614174000';
const OTHER = '223e4567-e89b-42d3-a456-426614174000';
const session = { kind: 'session', hostId: HOST, localId: 'same-session' } as const;
const project = { kind: 'project', hostId: HOST, localId: 'same-project' } as const;
const pane = { kind: 'pane', hostId: HOST, localId: 'same-pane', lane: 'external', tmux: { socketPath: '/tmp/a.sock', sessionId: '$1', windowId: '@1', paneId: '%1' }, process: { pid: 4001, startedAtMs: 1001 } } as const;
const target: MutationActionTarget = { token: 'verified' };
function request(targetValue: FleetSessionReference, body: Readonly<Record<string, string | number>>) { return { kind: 'request', protocolVersion: 'fleet/1', connectionGeneration: 7, requestId: 'mutation-chat.send', operation: 'chat.send', target: targetValue, body } as const; }
test('Given mutation wire input, when parsed, then operation fields and deadlines are exact', () => {
  assert.equal(parseFleetMutationRequest(request(session, { deadlineAtMs: 9_000, message: 'hello' })).operation, 'chat.send');
  assert.throws(() => parseFleetMutationRequest(request(session, { deadlineAtMs: 9_000, message: 'hello', extra: 'no' })));
  assert.throws(() => parseFleetMutationRequest(request(session, { deadlineAtMs: 0, message: 'hello' })));
});
function services(calls: string[], stale = false): FleetMutationServices {
  const action = async (): Promise<void> => { calls.push('action'); };
  return { verifySession: async () => { calls.push('verify'); return target; }, verifyPane: async () => { calls.push('verify'); return target; }, verifySpawn: async () => { calls.push('verify'); return { cwd: '/home/peer/workspace' }; }, finalCheck: async () => { calls.push('final'); if (stale) throw new FleetMutationClientError('FLEET_STALE_GENERATION', 'stale', 'none'); }, send: action, abort: action, interrupt: action, escape: action, respondPrompt: async () => { await action(); return { action: 'selected' }; }, respondApproval: action, spawn: async () => { await action(); return { ok: true }; }, terminateProcess: action, terminatePane: action, terminateSession: action };
}
test('Given every mutation family, when executed, then verifier, final check, and action run exactly once in order', async () => {
  const calls: string[] = []; const handlers = createFleetMutationHandlers(HOST, services(calls), () => 1_000);
  const requests = [
    { operation: 'chat.send', target: session, body: { deadlineAtMs: 9_000, message: 'chat' } }, { operation: 'chat.abort', target: session, body: { deadlineAtMs: 9_000 } },
    { operation: 'pane.input', target: pane, body: { deadlineAtMs: 9_000, message: 'pane' } }, { operation: 'pane.interrupt', target: pane, body: { deadlineAtMs: 9_000 } }, { operation: 'pane.escape', target: pane, body: { deadlineAtMs: 9_000 } },
    { operation: 'prompt.respond', target: session, body: { deadlineAtMs: 9_000, response: 'choices', promptId: '0123456789abcdef0123456789abcdef', choices: [1] } },
    { operation: 'approval.respond', target: session, body: { deadlineAtMs: 9_000, decision: 'approve-once' } }, { operation: 'session.spawn', target: project, body: { deadlineAtMs: 9_000, name: 'agent-one', cwd: 'workspace' } },
    { operation: 'process.terminate', target: pane, body: { deadlineAtMs: 9_000 } }, { operation: 'pane.terminate', target: pane, body: { deadlineAtMs: 9_000 } }, { operation: 'session.terminate', target: pane, body: { deadlineAtMs: 9_000 } },
  ] as const;
  for (const [index, value] of requests.entries()) { calls.length = 0; const handler = handlers[value.operation]; if (handler === undefined) throw new TypeError('mutation handler missing'); await handler({ kind: 'request', protocolVersion: 'fleet/1', connectionGeneration: 7, requestId: `request-${index}`, ...value }); assert.deepEqual(calls, ['verify', 'final', 'action']); }
});
test('Given final authorization consumes the remaining deadline, when any mutation reaches the shared action seam, then equality and elapsed time reject with no effect', async () => {
  const requests = [
    { operation: 'chat.send', target: session, body: { deadlineAtMs: 2_000, message: 'chat' } }, { operation: 'chat.abort', target: session, body: { deadlineAtMs: 2_000 } },
    { operation: 'pane.input', target: pane, body: { deadlineAtMs: 2_000, message: 'pane' } }, { operation: 'pane.interrupt', target: pane, body: { deadlineAtMs: 2_000 } }, { operation: 'pane.escape', target: pane, body: { deadlineAtMs: 2_000 } },
    { operation: 'prompt.respond', target: session, body: { deadlineAtMs: 2_000, response: 'choices', promptId: '0123456789abcdef0123456789abcdef', choices: [1] } },
    { operation: 'approval.respond', target: session, body: { deadlineAtMs: 2_000, decision: 'approve-once' } }, { operation: 'session.spawn', target: project, body: { deadlineAtMs: 2_000, name: 'agent-one', cwd: 'workspace' } },
    { operation: 'process.terminate', target: pane, body: { deadlineAtMs: 2_000 } }, { operation: 'pane.terminate', target: pane, body: { deadlineAtMs: 2_000 } }, { operation: 'session.terminate', target: pane, body: { deadlineAtMs: 2_000 } },
  ] as const;
  for (const [index, value] of requests.entries()) {
    const calls: string[] = []; let nowMs = 1_999;
    const delayed: FleetMutationServices = { ...services(calls), finalCheck: async () => { calls.push('final'); nowMs = index % 2 === 0 ? 2_000 : 2_001; } };
    const handler = createFleetMutationHandlers(HOST, delayed, () => nowMs)[value.operation]; if (handler === undefined) throw new TypeError('mutation handler missing');
    await assert.rejects(handler({ kind: 'request', protocolVersion: 'fleet/1', connectionGeneration: 7, requestId: `deadline-${index}`, ...value }), (error) => error instanceof FleetMutationRpcError && error.code === 'FLEET_DEADLINE_EXCEEDED');
    assert.deepEqual(calls, ['verify', 'final']);
  }
});

test('Given session and pane authorization finish at the deadline boundary, when dispatched, then canonical failures report no side effect', async () => {
  const requests: readonly FleetRequestEnvelope[] = [
    { kind: 'request', protocolVersion: 'fleet/1', connectionGeneration: 7, requestId: 'boundary-session', operation: 'chat.send', target: session, body: { deadlineAtMs: 2_000, message: 'chat' } },
    { kind: 'request', protocolVersion: 'fleet/1', connectionGeneration: 7, requestId: 'boundary-pane', operation: 'pane.interrupt', target: pane, body: { deadlineAtMs: 2_000 } },
  ];
  for (const requestValue of requests) {
    let nowMs = 1_999; let actions = 0; const action = async (): Promise<void> => { actions += 1; };
    const delayed: FleetMutationServices = { ...services([]), finalCheck: async () => { nowMs = 2_000; }, send: action, interrupt: action };
    const response = await createPeerOperationDispatcher(HOST, createFleetMutationHandlers(HOST, delayed, () => nowMs))(requestValue);
    assert.equal(response.status, 'failure'); assert.equal(response.sideEffect, 'none'); if (response.status === 'failure') assert.equal(response.error, 'FLEET_DEADLINE_EXCEEDED'); assert.equal(actions, 0);
  }
});

test('Given wrong-host or stale-final-check input, when handled, then no action occurs', async () => {
  const calls: string[] = []; const send = createFleetMutationHandlers(HOST, services(calls, true), () => 1_000)['chat.send']; if (send === undefined) throw new TypeError('send handler missing');
  await assert.rejects(send(request({ ...session, hostId: OTHER }, { deadlineAtMs: 9_000, message: 'wrong' }))); assert.deepEqual(calls, []);
  await assert.rejects(send(request(session, { deadlineAtMs: 9_000, message: 'stale' }))); assert.deepEqual(calls, ['verify', 'final']);
});
class Channel implements FleetMutationChannel {
  readonly sent: FleetProtocolFrame[] = []; readonly frames = new Set<(hostId: string, frame: FleetProtocolFrame) => void>(); readonly statuses = new Set<(status: HubPeerStatus) => void>(); onSend: (() => void) | undefined;
  value: HubPeerStatus = { peerId: HOST, state: 'online', protocolVersion: 'fleet/1', capabilities: ['chat.control'], peerProcessEpoch: 'a', generation: 7, lastHeartbeatAtMs: 1 };
  status(): HubPeerStatus { return this.value; } send(_hostId: string, frame: FleetProtocolFrame): boolean { this.sent.push(frame); this.onSend?.(); return true; }
  subscribeFrames(listener: (hostId: string, frame: FleetProtocolFrame) => void): () => void { this.frames.add(listener); return () => this.frames.delete(listener); }
  subscribeStatus(listener: (status: HubPeerStatus) => void): () => void { this.statuses.add(listener); return () => this.statuses.delete(listener); }
  transition(state: HubPeerStatus['state'], generation: number): void { this.value = { ...this.value, state, generation }; for (const listener of this.statuses) listener(this.value); }
}
test('Given a real post-dispatch unknown outcome, when transcript and discovery reconcile it, then status stays unknown until evidence and no mutation replays', async () => {
  const channel = new Channel(); channel.onSend = () => channel.transition('offline', 7); let unknown: FleetMutationClientError | undefined;
  try { await new FleetMutationClient(channel).sendChat(session, { requestId: 'collision-id', deadlineAtMs: Date.now() + 2_000, message: 'hello' }); }
  catch (error) { if (error instanceof FleetMutationClientError) unknown = error; else throw error; }
  assert.equal(unknown?.code, 'HOST_COMMAND_OUTCOME_UNKNOWN'); assert.equal(unknown?.sideEffect, 'possible');
  if (unknown?.outcome === null || unknown?.outcome === undefined) throw new TypeError('unknown outcome tracker missing');
  const reads: string[] = []; const evidence = Promise.withResolvers<'applied'>(); const started = Promise.withResolvers<void>();
  const reconciliation = unknown.outcome.reconcile(async () => { reads.push('transcript', 'discovery'); started.resolve(); return evidence.promise; });
  await started.promise; assert.equal(unknown.outcome.status, 'unknown'); channel.transition('online', 8); assert.equal(channel.sent.length, 1);
  evidence.resolve('applied'); assert.equal(await reconciliation, 'resolved_applied'); assert.equal(unknown.outcome.status, 'resolved_applied');
  assert.deepEqual(reads, ['transcript', 'discovery']); assert.equal(channel.sent.length, 1); assert.equal(channel.frames.size, 0); assert.equal(channel.statuses.size, 0);
});
