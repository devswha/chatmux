import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import type { FleetEvent, FleetPaneReference, JsonValue } from '../../../../shared/fleet.js';
import { paneSubscriptionKey } from '../../../../shared/tmux.js';
import { createPeerOperationDispatcher } from '../peer/operation-dispatcher.js';
import { createRemoteTerminalPeer, type RemoteTerminalProcess } from '../terminal/index.js';

const HOST_A = '11111111-1111-4111-8111-111111111111';
const HOST_B = '22222222-2222-4222-8222-222222222222';
const pane: FleetPaneReference = {
  kind: 'pane', hostId: HOST_A, localId: 'session-1', lane: 'external',
  tmux: { socketPath: '/tmp/peer-a.sock', sessionId: '$1', windowId: '@1', paneId: '%1' },
  process: { pid: 42, startedAtMs: 100 },
};
const lease = {
  token: 'lease-token-1234567890', ownerPrincipal: 'owner-1', peerId: HOST_A,
  paneKey: paneSubscriptionKey(pane.lane, pane.tmux, pane.process),
  operations: ['attach', 'input', 'resize', 'close'] as const,
  expiresAtMs: 2_000, connectionGeneration: 7,
};

class FakeProcess extends EventEmitter implements RemoteTerminalProcess {
  readonly writes: string[] = [];
  readonly sizes: Array<readonly [number, number]> = [];
  closed = 0;
  onData(listener: (data: string) => void): void { this.on('data', listener); }
  onExit(listener: () => void): void { this.on('exit', listener); }
  write(data: string): void { this.writes.push(data); }
  resize(cols: number, rows: number): void { this.sizes.push([cols, rows]); }
  close(): void { this.closed += 1; }
  output(data: string): void { this.emit('data', data); }
}

function body(value: JsonValue): Readonly<Record<string, JsonValue>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('expected object body');
  return Object.fromEntries(Object.entries(value));
}

test('peer owns attach, input, resize, output replay, and close without controller tmux', async () => {
  // Given
  let now = 1_000;
  const spawned: FakeProcess[] = [];
  const events: Array<Readonly<{ event: FleetEvent; body: JsonValue }>> = [];
  const peer = createRemoteTerminalPeer({
    hostId: HOST_A, processEpoch: 'peer-process-1', now: () => now,
    isConnectionCurrent: (generation) => generation === 7,
    verifyTarget: async (target) => target,
    spawn: async () => { const process = new FakeProcess(); spawned.push(process); return process; },
    publish: (event, eventBody) => events.push({ event, body: eventBody }),
  });

  // When
  const attached = body(await peer.handlers['pane.attach']?.({
    kind: 'request', protocolVersion: 'fleet/1', connectionGeneration: 7,
    requestId: 'attach-1', operation: 'pane.attach', target: pane,
    body: { deadlineAtMs: 1_500, lease, cols: 80, rows: 24, resume: null },
  }) ?? null);
  spawned[0]?.output('one');
  spawned[0]?.output('two');
  await peer.handlers['pane.input']?.({
    kind: 'request', protocolVersion: 'fleet/1', connectionGeneration: 7,
    requestId: 'input-1', operation: 'pane.input', target: pane,
    body: { deadlineAtMs: 1_500, lease, streamEpoch: attached.streamEpoch, data: 'ls\r' },
  });
  await peer.handlers['pane.resize']?.({
    kind: 'request', protocolVersion: 'fleet/1', connectionGeneration: 7,
    requestId: 'resize-1', operation: 'pane.resize', target: pane,
    body: { deadlineAtMs: 1_500, lease, streamEpoch: attached.streamEpoch, cols: 120, rows: 40 },
  });
  const replay = body(await peer.handlers['pane.attach']?.({
    kind: 'request', protocolVersion: 'fleet/1', connectionGeneration: 7,
    requestId: 'attach-2', operation: 'pane.attach', target: pane,
    body: { deadlineAtMs: 1_500, lease, cols: 120, rows: 40, resume: {
      peerProcessEpoch: 'peer-process-1', terminalSessionId: attached.terminalSessionId,
      streamEpoch: attached.streamEpoch, lastSeq: 1,
    } },
  }) ?? null);
  await peer.handlers['pane.escape']?.({
    kind: 'request', protocolVersion: 'fleet/1', connectionGeneration: 7,
    requestId: 'close-1', operation: 'pane.escape', target: pane,
    body: { deadlineAtMs: 1_500, lease, streamEpoch: attached.streamEpoch, action: 'close' },
  });

  // Then
  assert.equal(spawned.length, 1);
  assert.deepEqual(spawned[0]?.writes, ['ls\r']);
  assert.deepEqual(spawned[0]?.sizes, [[120, 40]]);
  assert.equal(replay.replay, 'resume');
  assert.deepEqual(events.map((event) => [event.event, body(event.body).seq, body(event.body).data]), [
    ['pane.output', 1, 'one'], ['pane.output', 2, 'two'], ['pane.output', 2, 'two'],
  ]);
  assert.equal(spawned[0]?.closed, 1);
  now = 2_000;
});

test('disconnect after spawn starts closes the uncommitted PTY exactly once', async () => {
  // Given
  let releaseSpawn: (() => void) | undefined;
  let announceSpawn: (() => void) | undefined;
  const spawnStarted = new Promise<void>((resolve) => { announceSpawn = resolve; });
  const spawnReleased = new Promise<void>((resolve) => { releaseSpawn = resolve; });
  const process = new FakeProcess();
  const peer = createRemoteTerminalPeer({
    hostId: HOST_A, processEpoch: 'peer-process-1', now: () => 1_000,
    isConnectionCurrent: (generation) => generation === 7,
    verifyTarget: async (target) => target,
    spawn: async () => { announceSpawn?.(); await spawnReleased; return process; },
    publish: () => undefined,
  });
  const dispatch = createPeerOperationDispatcher(HOST_A, peer.handlers);
  const pending = dispatch({
    kind: 'request', protocolVersion: 'fleet/1', connectionGeneration: 7,
    requestId: 'attach-spawn-race', operation: 'pane.attach', target: pane,
    body: { deadlineAtMs: 1_500, lease, cols: 80, rows: 24, resume: null },
  });
  let rejectTimeout: ((error: TypeError) => void) | undefined;
  const timeout = setTimeout(() => rejectTimeout?.(new TypeError('spawn signal timeout')), 1_000);
  try { await Promise.race([spawnStarted, new Promise<never>((_resolve, reject) => { rejectTimeout = reject; })]); }
  finally { clearTimeout(timeout); }

  // When
  peer.closeGeneration(7);
  releaseSpawn?.();

  // Then
  const response = await pending;
  assert.equal(response.status, 'failure');
  if (response.status !== 'failure') throw new TypeError('expected stale terminal response');
  assert.equal(response.error, 'FLEET_STALE_GENERATION');
  assert.equal(process.closed, 1);
  peer.closeGeneration(7);
  assert.equal(process.closed, 1);
});

test('spawn commit rechecks lease expiry, deadline, and exact target generation', async () => {
  for (const scenario of ['expiry', 'deadline', 'target'] as const) {
    // Given
    let now = 1_000; let verifications = 0;
    let announceSpawn: (() => void) | undefined; let releaseSpawn: (() => void) | undefined;
    const spawnStarted = new Promise<void>((resolve) => { announceSpawn = resolve; });
    const spawnReleased = new Promise<void>((resolve) => { releaseSpawn = resolve; });
    const process = new FakeProcess();
    const peer = createRemoteTerminalPeer({
      hostId: HOST_A, processEpoch: 'peer-process-1', now: () => now,
      isConnectionCurrent: (generation) => generation === 7,
      verifyTarget: async (target) => { verifications += 1; if (scenario === 'target' && verifications === 2) throw new TypeError('target changed'); return target; },
      spawn: async () => { announceSpawn?.(); await spawnReleased; return process; }, publish: () => undefined,
    });
    const dispatch = createPeerOperationDispatcher(HOST_A, peer.handlers);
    const candidateLease = { ...lease, expiresAtMs: scenario === 'expiry' ? 2_000 : 4_000 };
    const pending = dispatch({
      kind: 'request', protocolVersion: 'fleet/1', connectionGeneration: 7,
      requestId: `spawn-recheck-${scenario}`, operation: 'pane.attach', target: pane,
      body: { deadlineAtMs: scenario === 'deadline' ? 1_500 : 3_000, lease: candidateLease, cols: 80, rows: 24, resume: null },
    });
    let rejectTimeout: ((error: TypeError) => void) | undefined;
    const timeout = setTimeout(() => rejectTimeout?.(new TypeError('spawn signal timeout')), 1_000);
    try { await Promise.race([spawnStarted, new Promise<never>((_resolve, reject) => { rejectTimeout = reject; })]); }
    finally { clearTimeout(timeout); }

    // When
    if (scenario === 'expiry') now = 2_000;
    if (scenario === 'deadline') now = 1_500;
    releaseSpawn?.();
    const response = await pending;

    // Then
    assert.equal(response.status, 'failure', scenario);
    if (response.status !== 'failure') throw new TypeError('expected stale terminal response');
    assert.equal(response.error, 'FLEET_STALE_GENERATION', scenario);
    assert.equal(process.closed, 1, scenario);
  }
});

test('authorization failures and disconnect between verification and spawn have zero side effects', async () => {
  for (const scenario of ['wrong-host', 'wrong-principal', 'wrong-pane', 'wrong-generation', 'wrong-operation', 'expired', 'superseded'] as const) {
    // Given
    let current = true;
    let now = scenario === 'expired' ? 2_000 : 1_000;
    let verified = 0;
    let spawned = 0;
    let announceVerification: (() => void) | undefined;
    let releaseVerification: (() => void) | undefined;
    const verificationStarted = new Promise<void>((resolve) => { announceVerification = resolve; });
    const verificationReleased = new Promise<void>((resolve) => { releaseVerification = resolve; });
    const peer = createRemoteTerminalPeer({
      hostId: HOST_A, processEpoch: 'peer-process-1', now: () => now,
      isConnectionCurrent: (generation) => current && generation === 7,
      verifyTarget: async (target) => {
        verified += 1; announceVerification?.();
        if (scenario === 'superseded') await verificationReleased;
        return target;
      },
      spawn: async () => { spawned += 1; return new FakeProcess(); }, publish: () => undefined,
    });
    const target = scenario === 'wrong-host' ? { ...pane, hostId: HOST_B } : scenario === 'wrong-pane'
      ? { ...pane, tmux: { ...pane.tmux, paneId: '%2' } } : pane;
    const candidateLease = scenario === 'wrong-principal' ? { ...lease, ownerPrincipal: '' }
      : scenario === 'wrong-generation' ? { ...lease, connectionGeneration: 8 }
        : scenario === 'wrong-operation' ? { ...lease, operations: ['input', 'resize', 'close', 'close'] as const } : lease;

    // When
    const operation = peer.handlers['pane.attach'];
    assert.ok(operation);
    const pending = operation({
      kind: 'request', protocolVersion: 'fleet/1', connectionGeneration: 7,
      requestId: `attach-${scenario}`, operation: 'pane.attach', target,
      body: { deadlineAtMs: 1_500, lease: candidateLease, cols: 80, rows: 24, resume: null },
    });
    if (scenario === 'superseded') {
      let rejectTimeout: ((error: TypeError) => void) | undefined;
      const timeout = setTimeout(() => rejectTimeout?.(new TypeError('verification signal timeout')), 1_000);
      try { await Promise.race([verificationStarted, new Promise<never>((_resolve, reject) => { rejectTimeout = reject; })]); }
      finally { clearTimeout(timeout); }
      current = false;
      releaseVerification?.();
    }

    // Then
    await assert.rejects(pending);
    assert.equal(spawned, 0, scenario);
    if (scenario !== 'superseded') assert.equal(verified, 0, scenario);
    now += 1;
  }
});

test('pane output larger than one frame is published as consecutive chunks that never split a surrogate pair', async () => {
  const { chunkTerminalOutput, OUTPUT_CHUNK_CHARS } = await import('../terminal/peer.js');
  assert.deepEqual(chunkTerminalOutput('short'), ['short']);
  const big = 'a'.repeat(OUTPUT_CHUNK_CHARS * 2 + 10);
  assert.deepEqual(chunkTerminalOutput(big).map((piece) => piece.length), [OUTPUT_CHUNK_CHARS, OUTPUT_CHUNK_CHARS, 10]);
  const emoji = 'x'.repeat(OUTPUT_CHUNK_CHARS - 1) + String.fromCodePoint(0x1f600) + 'y';
  const pieces = chunkTerminalOutput(emoji);
  assert.deepEqual(pieces.map((piece) => piece.length), [OUTPUT_CHUNK_CHARS - 1, 3], 'the boundary moves back rather than cutting the pair');
  assert.equal(pieces.join(''), emoji);

  let now = 1_000;
  const spawned: FakeProcess[] = [];
  const events: Array<Readonly<{ event: FleetEvent; body: JsonValue }>> = [];
  const peer = createRemoteTerminalPeer({
    hostId: HOST_A, processEpoch: 'peer-process-1', now: () => now,
    isConnectionCurrent: (generation) => generation === 7,
    verifyTarget: async (target) => target,
    spawn: async () => { const process = new FakeProcess(); spawned.push(process); return process; },
    publish: (event, eventBody) => events.push({ event, body: eventBody }),
  });
  await peer.handlers['pane.attach']?.({
    kind: 'request', protocolVersion: 'fleet/1', connectionGeneration: 7,
    requestId: 'attach-big', operation: 'pane.attach', target: pane,
    body: { deadlineAtMs: 1_500, lease, cols: 80, rows: 24, resume: null },
  });
  now += 1;
  const escape = String.fromCharCode(27);
  const redraw = (escape + '[31m').repeat(OUTPUT_CHUNK_CHARS);
  spawned[0]?.output(redraw);
  const outputs = events.filter((entry) => entry.event === 'pane.output').map((entry) => body(entry.body));
  assert.equal(outputs.length, Math.ceil(redraw.length / OUTPUT_CHUNK_CHARS));
  assert.deepEqual(outputs.map((output) => output.seq), outputs.map((_output, index) => index + 1), 'chunks carry consecutive sequence numbers');
  assert.equal(outputs.map((output) => output.data).join(''), redraw);
  for (const output of outputs) assert.ok(JSON.stringify(output).length < 64 * 1024, 'each chunk fits one frame after JSON escaping');
});
