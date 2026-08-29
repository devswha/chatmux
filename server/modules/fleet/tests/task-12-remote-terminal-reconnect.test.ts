import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import type { FleetEvent, FleetPaneReference, FleetResponseEnvelope, JsonValue } from '../../../../shared/fleet.js';
import { RemoteTerminalClient, createRemoteTerminalPeer, type RemoteTerminalChannel, type RemoteTerminalHandlers, type RemoteTerminalProcess, type RemoteTerminalSink } from '../terminal/index.js';
import type { HubPeerStatus } from '../hub/connection/types.js';
import type { FleetProtocolFrame } from '../protocol/types.js';

const HOST_A = '11111111-1111-4111-8111-111111111111';
const HOST_B = '22222222-2222-4222-8222-222222222222';
const target: FleetPaneReference = {
  kind: 'pane', hostId: HOST_A, localId: 'session-1', lane: 'external',
  tmux: { socketPath: '/tmp/collision.sock', sessionId: '$1', windowId: '@1', paneId: '%1' },
  process: { pid: 42, startedAtMs: 100 },
};
function online(peerId: string, generation: number, processEpoch: string): HubPeerStatus {
  return { peerId, state: 'online', protocolVersion: 'fleet/1', capabilities: ['terminal.attach', 'terminal.input', 'pane.read'], peerProcessEpoch: processEpoch, generation, lastHeartbeatAtMs: 1_000 };
}
class Process extends EventEmitter implements RemoteTerminalProcess {
  closed = 0;
  onData(listener: (data: string) => void): void { this.on('data', listener); }
  onExit(listener: () => void): void { this.on('exit', listener); }
  write(): void {}
  resize(): void {}
  close(): void { this.closed += 1; }
  output(data: string): void { this.emit('data', data); }
}
class Sink implements RemoteTerminalSink {
  readonly bufferedAmount = 0;
  readonly outputFrames: Array<readonly [string, number, boolean]> = [];
  readonly closes: string[] = [];
  output(data: string, seq: number, replay: boolean): void { this.outputFrames.push([data, seq, replay]); }
  close(reason: 'closed' | 'disconnected' | 'revoked' | 'slow_consumer'): void { this.closes.push(reason); }
}
type Peer = Readonly<{ readonly status: HubPeerStatus; readonly handlers: RemoteTerminalHandlers }>;
function leaseToken(body: JsonValue): string {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new TypeError('expected terminal request body');
  const lease = Object.entries(body).find(([key]) => key === 'lease')?.[1];
  if (lease === null || typeof lease !== 'object' || Array.isArray(lease)) throw new TypeError('expected server lease');
  const token = Object.entries(lease).find(([key]) => key === 'token')?.[1];
  if (typeof token !== 'string') throw new TypeError('expected server lease token');
  return token;
}
class LoopbackChannel implements RemoteTerminalChannel {
  readonly leaseTokens: string[] = [];
  private readonly peers = new Map<string, Peer>();
  private readonly frames = new Set<(hostId: string, frame: FleetProtocolFrame) => void>();
  private readonly statusListeners = new Set<(status: HubPeerStatus) => void>();
  status(hostId: string): HubPeerStatus | undefined { return this.peers.get(hostId)?.status; }
  setPeer(peer: Peer): void {
    this.peers.set(peer.status.peerId, peer);
    for (const listener of this.statusListeners) listener(peer.status);
  }
  send(hostId: string, frame: FleetProtocolFrame): boolean {
    const peer = this.peers.get(hostId);
    if (peer === undefined || frame.kind !== 'request' || frame.operation !== 'pane.attach') return false;
    this.leaseTokens.push(leaseToken(frame.body));
    void peer.handlers['pane.attach'](frame).then((body) => this.emitResponse(hostId, frame, body)).catch((error: unknown) => {
      if (!(error instanceof Error)) throw error;
      const response: FleetResponseEnvelope = { kind: 'response', protocolVersion: 'fleet/1', connectionGeneration: frame.connectionGeneration, requestId: frame.requestId, target: frame.target, status: 'failure', sideEffect: 'none', error: 'FLEET_UNAUTHORIZED', body: null };
      for (const listener of this.frames) listener(hostId, response);
    });
    return true;
  }
  subscribeFrames(listener: (hostId: string, frame: FleetProtocolFrame) => void): () => void { this.frames.add(listener); return () => this.frames.delete(listener); }
  subscribeStatus(listener: (status: HubPeerStatus) => void): () => void { this.statusListeners.add(listener); return () => this.statusListeners.delete(listener); }
  publish(hostId: string, event: FleetEvent, body: JsonValue): void {
    const generation = this.peers.get(hostId)?.status.generation;
    if (generation === null || generation === undefined) return;
    const frame = { kind: 'event', protocolVersion: 'fleet/1', connectionGeneration: generation, eventId: `event-${crypto.randomUUID()}`, event, hostId, body } as const;
    for (const listener of this.frames) listener(hostId, frame);
  }
  private emitResponse(hostId: string, request: Extract<FleetProtocolFrame, { readonly kind: 'request' }>, body: JsonValue): void {
    const response: FleetResponseEnvelope = { kind: 'response', protocolVersion: 'fleet/1', connectionGeneration: request.connectionGeneration, requestId: request.requestId, target: request.target, status: 'success', sideEffect: 'applied', body };
    for (const listener of this.frames) listener(hostId, response);
  }
}

test('production client-to-peer reconnect reuses one PTY, then restart redraws without touching collision peer B', async () => {
  // Given
  const channel = new LoopbackChannel(); const processes: Process[] = [];
  let spawnA = 0; let spawnB = 0;
  const peerA = createRemoteTerminalPeer({
    hostId: HOST_A, processEpoch: 'process-1', now: () => 1_000,
    isConnectionCurrent: (generation) => generation === 7, verifyTarget: async (candidate) => candidate,
    spawn: async () => { spawnA += 1; const process = new Process(); processes.push(process); return process; },
    publish: (event, body) => channel.publish(HOST_A, event, body),
  });
  const peerB = createRemoteTerminalPeer({
    hostId: HOST_B, processEpoch: 'process-b', now: () => 1_000,
    isConnectionCurrent: (generation) => generation === 7, verifyTarget: async (candidate) => candidate,
    spawn: async () => { spawnB += 1; return new Process(); }, publish: (event, body) => channel.publish(HOST_B, event, body),
  });
  channel.setPeer({ status: online(HOST_A, 7, 'process-1'), handlers: peerA.handlers });
  channel.setPeer({ status: online(HOST_B, 7, 'process-b'), handlers: peerB.handlers });
  const client = new RemoteTerminalClient(channel, { now: () => 1_000 });
  const first = await client.attach({ principal: 'owner-1', owner: true, target, cols: 80, rows: 24, deadlineAtMs: 2_000, resume: null, sink: new Sink() });
  processes[0]?.output('one'); processes[0]?.output('two'); first.detach();

  // When: exact reconnect acknowledges no output and reuses the server-held lease.
  const reconnectSink = new Sink();
  const reconnect = await client.attach({ principal: 'owner-1', owner: true, target, cols: 80, rows: 24, deadlineAtMs: 2_000, resume: { ...first.resume, lastSeq: 0 }, sink: reconnectSink });

  // Then
  assert.equal(reconnect.replay, 'resume'); assert.equal(spawnA, 1);
  assert.equal(channel.leaseTokens[1], channel.leaseTokens[0], 'only the hub reuses the original opaque lease');
  assert.deepEqual(reconnectSink.outputFrames, [['one', 1, true], ['two', 2, true]]);
  reconnect.detach(); peerA.closeGeneration(7);

  // When: peer A restarts with a new connection/process epoch.
  const restartedPeerA = createRemoteTerminalPeer({
    hostId: HOST_A, processEpoch: 'process-2', now: () => 1_000,
    isConnectionCurrent: (generation) => generation === 8, verifyTarget: async (candidate) => candidate,
    spawn: async () => { spawnA += 1; return new Process(); }, publish: (event, body) => channel.publish(HOST_A, event, body),
  });
  channel.setPeer({ status: online(HOST_A, 8, 'process-2'), handlers: restartedPeerA.handlers });
  const restarted = await client.attach({ principal: 'owner-1', owner: true, target, cols: 80, rows: 24, deadlineAtMs: 2_000, resume: reconnect.resume, sink: new Sink() });

  // Then
  assert.equal(restarted.replay, 'redraw'); assert.equal(spawnA, 2); assert.equal(spawnB, 0);
  assert.notEqual(channel.leaseTokens[2], channel.leaseTokens[1], 'restart mints fresh authority');
  assert.equal(processes[0]?.closed, 1);
  restarted.detach(); client.dispose(); peerA.dispose(); peerB.dispose(); restartedPeerA.dispose();
});
