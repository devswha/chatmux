import assert from 'node:assert/strict';
import test from 'node:test';

import type { FleetPaneReference, FleetResponseEnvelope, JsonValue } from '../../../../shared/fleet.js';
import { RemoteTerminalClient, type RemoteTerminalChannel, type RemoteTerminalSink } from '../terminal/client.js';
import type { HubPeerStatus } from '../hub/connection/types.js';
import type { FleetProtocolFrame } from '../protocol/types.js';

const HOST_A = '11111111-1111-4111-8111-111111111111';
const HOST_B = '22222222-2222-4222-8222-222222222222';
const target: FleetPaneReference = {
  kind: 'pane', hostId: HOST_A, localId: 'session-1', lane: 'external',
  tmux: { socketPath: '/tmp/a.sock', sessionId: '$1', windowId: '@1', paneId: '%1' },
  process: { pid: 42, startedAtMs: 100 },
};
function online(peerId = HOST_A, generation = 7, processEpoch = 'peer-process-1'): HubPeerStatus {
  return { peerId, state: 'online', protocolVersion: 'fleet/1', capabilities: ['terminal.attach', 'terminal.input', 'pane.read'], peerProcessEpoch: processEpoch, generation, lastHeartbeatAtMs: 1_000 };
}
class FakeChannel implements RemoteTerminalChannel {
  readonly sent: Array<Readonly<{ hostId: string; frame: FleetProtocolFrame }>> = [];
  readonly statuses = new Map<string, HubPeerStatus>([[HOST_A, online()], [HOST_B, online(HOST_B)]]);
  private readonly frames = new Set<(hostId: string, frame: FleetProtocolFrame) => void>();
  private readonly statusListeners = new Set<(status: HubPeerStatus) => void>();
  status(hostId: string): HubPeerStatus | undefined { return this.statuses.get(hostId); }
  send(hostId: string, frame: FleetProtocolFrame): boolean { this.sent.push({ hostId, frame }); return true; }
  subscribeFrames(listener: (hostId: string, frame: FleetProtocolFrame) => void): () => void { this.frames.add(listener); return () => this.frames.delete(listener); }
  subscribeStatus(listener: (status: HubPeerStatus) => void): () => void { this.statusListeners.add(listener); return () => this.statusListeners.delete(listener); }
  emitFrame(hostId: string, frame: FleetProtocolFrame): void { for (const listener of this.frames) listener(hostId, frame); }
  emitStatus(status: HubPeerStatus): void { this.statuses.set(status.peerId, status); for (const listener of this.statusListeners) listener(status); }
}
class Sink implements RemoteTerminalSink {
  bufferedAmount = 0;
  readonly outputs: Array<readonly [string, number, boolean]> = [];
  readonly closes: string[] = [];
  output(data: string, seq: number, replay: boolean): void { this.outputs.push([data, seq, replay]); }
  close(reason: 'closed' | 'disconnected' | 'revoked' | 'slow_consumer'): void { this.closes.push(reason); }
}
function success(request: Extract<FleetProtocolFrame, { readonly kind: 'request' }>, body: JsonValue): FleetResponseEnvelope {
  return { kind: 'response', protocolVersion: 'fleet/1', connectionGeneration: request.connectionGeneration, requestId: request.requestId, target: request.target, status: 'success', sideEffect: 'applied', body };
}
function requestAt(channel: FakeChannel, index: number): Extract<FleetProtocolFrame, { readonly kind: 'request' }> {
  const frame = channel.sent[index]?.frame;
  if (frame?.kind !== 'request') throw new TypeError('expected request');
  return frame;
}

test('hub binds owner attach and forwards input, resize, output, and close to peer A only', async () => {
  // Given
  let now = 1_000;
  const channel = new FakeChannel(); const sink = new Sink();
  const client = new RemoteTerminalClient(channel, { now: () => now });
  const pending = client.attach({ principal: 'owner-1', owner: true, target, cols: 80, rows: 24, deadlineAtMs: 2_000, resume: null, sink });
  const attachRequest = requestAt(channel, 0);
  channel.emitFrame(HOST_A, success(attachRequest, { terminalSessionId: 'terminal-1', streamEpoch: 'stream-1', peerProcessEpoch: 'peer-process-1', replay: 'redraw', lastSeq: 0 }));
  const attachment = await pending;

  // When
  const input = attachment.input('pwd\r', 2_000); channel.emitFrame(HOST_A, success(requestAt(channel, 1), { ok: true })); await input;
  const resize = attachment.resize(120, 40, 2_000); channel.emitFrame(HOST_A, success(requestAt(channel, 2), { ok: true })); await resize;
  channel.emitFrame(HOST_A, { kind: 'event', protocolVersion: 'fleet/1', connectionGeneration: 7, eventId: 'output-1', event: 'pane.output', hostId: HOST_A, body: { terminalSessionId: 'terminal-1', streamEpoch: 'stream-1', peerProcessEpoch: 'peer-process-1', seq: 1, data: 'ready', replay: false, leaseToken: 'event-lease' } });
  const close = attachment.close(2_000); channel.emitFrame(HOST_A, success(requestAt(channel, 3), { ok: true })); await close;

  // Then
  assert.deepEqual(channel.sent.map((sent) => [sent.hostId, sent.frame.kind === 'request' ? sent.frame.operation : 'other']), [[HOST_A, 'pane.attach'], [HOST_A, 'pane.input'], [HOST_A, 'pane.resize'], [HOST_A, 'pane.escape']]);
  assert.deepEqual(sink.outputs, [['ready', 1, false]]);
  assert.deepEqual(sink.closes, ['closed']);
  assert.equal(channel.sent.some((sent) => sent.hostId === HOST_B), false);
  now += 1;
  client.dispose();
});

test('wrong principal, restart, revoke, and slow consumer fail closed without retargeting', async () => {
  // Given
  const channel = new FakeChannel(); const sink = new Sink();
  const client = new RemoteTerminalClient(channel, { now: () => 1_000, maxBufferedBytes: 8 });

  // When / Then: wrong principal is rejected before a fleet frame exists.
  await assert.rejects(client.attach({ principal: 'user-2', owner: false, target, cols: 80, rows: 24, deadlineAtMs: 2_000, resume: null, sink }));
  assert.equal(channel.sent.length, 0);

  // When: attach, isolate a slow browser, then revoke the peer.
  const pending = client.attach({ principal: 'owner-1', owner: true, target, cols: 80, rows: 24, deadlineAtMs: 2_000, resume: null, sink });
  channel.emitFrame(HOST_A, success(requestAt(channel, 0), { terminalSessionId: 'terminal-1', streamEpoch: 'stream-1', peerProcessEpoch: 'peer-process-1', replay: 'redraw', lastSeq: 0 }));
  await pending;
  sink.bufferedAmount = 0;
  channel.emitFrame(HOST_A, { kind: 'event', protocolVersion: 'fleet/1', connectionGeneration: 7, eventId: 'at-bound', event: 'pane.output', hostId: HOST_A, body: { terminalSessionId: 'terminal-1', streamEpoch: 'stream-1', peerProcessEpoch: 'peer-process-1', seq: 1, data: 'éééé', replay: false, leaseToken: 'event-lease' } });
  channel.emitFrame(HOST_A, { kind: 'event', protocolVersion: 'fleet/1', connectionGeneration: 7, eventId: 'over-bound', event: 'pane.output', hostId: HOST_A, body: { terminalSessionId: 'terminal-1', streamEpoch: 'stream-1', peerProcessEpoch: 'peer-process-1', seq: 2, data: 'ééééa', replay: false, leaseToken: 'event-lease' } });
  const revokedSink = new Sink();
  const revokePending = client.attach({ principal: 'owner-1', owner: true, target, cols: 80, rows: 24, deadlineAtMs: 2_000, resume: null, sink: revokedSink });
  const revokeAttachRequest = requestAt(channel, 2);
  channel.emitFrame(HOST_A, success(revokeAttachRequest, { terminalSessionId: 'terminal-revoke', streamEpoch: 'stream-revoke', peerProcessEpoch: 'peer-process-1', replay: 'redraw', lastSeq: 0 }));
  const revokedAttachment = await revokePending;
  channel.emitStatus({ ...online(), state: 'revoked' });
  const sentBeforeSuspendedInput = channel.sent.length;

  // Then
  assert.deepEqual(sink.outputs, [['éééé', 1, false]], 'equality is delivered and a nine-byte multibyte payload is not');
  assert.deepEqual(sink.closes, ['slow_consumer']);
  assert.deepEqual(revokedSink.closes, ['revoked']);
  await assert.rejects(revokedAttachment.input('blocked', 2_000));
  assert.equal(channel.sent.length, sentBeforeSuspendedInput, 'revoked input is suspended before transport');
  assert.equal(channel.sent.some((sent) => sent.hostId === HOST_B), false);

  // Given / When: a peer process restart strips stale replay identity.
  const restartedSink = new Sink(); channel.emitStatus(online(HOST_A, 8, 'peer-process-2'));
  const restarted = client.attach({ principal: 'owner-1', owner: true, target, cols: 80, rows: 24, deadlineAtMs: 2_000, resume: { peerProcessEpoch: 'peer-process-1', terminalSessionId: 'terminal-1', streamEpoch: 'stream-1', lastSeq: 1 }, sink: restartedSink });
  assert.equal(requestAt(channel, 1).operation, 'pane.escape', 'slow consumer closes only its owning peer stream');
  const restartedRequest = requestAt(channel, 3);
  assert.equal(restartedRequest.operation, 'pane.attach');
  const restartedBody = restartedRequest.body;
  if (restartedBody === null || typeof restartedBody !== 'object' || Array.isArray(restartedBody)) throw new TypeError('expected attach body');
  assert.equal(Object.entries(restartedBody).find(([key]) => key === 'resume')?.[1], null);
  channel.emitFrame(HOST_A, success(restartedRequest, { terminalSessionId: 'terminal-2', streamEpoch: 'stream-2', peerProcessEpoch: 'peer-process-2', replay: 'redraw', lastSeq: 0 }));
  assert.equal((await restarted).replay, 'redraw');
  client.dispose();
});

test('changed resume authority mints a new lease and suppresses stale resume identity', async () => {
  for (const scenario of ['owner', 'pane', 'terminal', 'stream', 'expiry', 'peer'] as const) {
    // Given
    let now = 1_000;
    const channel = new FakeChannel(); const firstSink = new Sink();
    const client = new RemoteTerminalClient(channel, { now: () => now, leaseTtlMs: 100 });
    const firstPending = client.attach({ principal: 'owner-1', owner: true, target, cols: 80, rows: 24, deadlineAtMs: 2_000, resume: null, sink: firstSink });
    const firstRequest = requestAt(channel, 0);
    channel.emitFrame(HOST_A, success(firstRequest, { terminalSessionId: 'terminal-1', streamEpoch: 'stream-1', peerProcessEpoch: 'peer-process-1', replay: 'redraw', lastSeq: 0 }));
    const first = await firstPending; first.detach();
    if (scenario === 'expiry') now = 1_100;
    const nextTarget = scenario === 'peer' ? { ...target, hostId: HOST_B } : scenario === 'pane' ? { ...target, tmux: { ...target.tmux, paneId: '%2' } } : target;
    const nextResume = scenario === 'terminal' ? { ...first.resume, terminalSessionId: 'terminal-2' }
      : scenario === 'stream' ? { ...first.resume, streamEpoch: 'stream-2' } : first.resume;
    const principal = scenario === 'owner' ? 'owner-2' : 'owner-1';

    // When
    const nextPending = client.attach({ principal, owner: true, target: nextTarget, cols: 80, rows: 24, deadlineAtMs: 2_000, resume: nextResume, sink: new Sink() });
    const nextRequest = requestAt(channel, 1);

    // Then
    const requestBody = nextRequest.body;
    if (requestBody === null || typeof requestBody !== 'object' || Array.isArray(requestBody)) throw new TypeError('expected terminal attach body');
    assert.equal(Object.entries(requestBody).find(([key]) => key === 'resume')?.[1], null, scenario);
    channel.emitFrame(nextTarget.hostId, success(nextRequest, { terminalSessionId: `fresh-${scenario}`, streamEpoch: `fresh-stream-${scenario}`, peerProcessEpoch: 'peer-process-1', replay: 'redraw', lastSeq: 0 }));
    assert.equal((await nextPending).replay, 'redraw', scenario);
    client.dispose();
  }
});
