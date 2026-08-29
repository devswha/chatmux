import assert from 'node:assert/strict';
import test from 'node:test';

import type { FleetProtocolFrame } from '../protocol/types.js';
import { FleetReadClient, FleetReadClientError, type FleetReadChannel } from '../rpc/reads/client.js';
import type { HubPeerStatus } from '../hub/connection/types.js';

const HOST = '123e4567-e89b-42d3-a456-426614174000';

class Channel implements FleetReadChannel {
  statusValue: HubPeerStatus | undefined;
  readonly sent: FleetProtocolFrame[] = [];
  readonly frameListeners = new Set<(hostId: string, frame: FleetProtocolFrame) => void>();
  readonly statusListeners = new Set<(status: HubPeerStatus) => void>();
  onSend: ((frame: FleetProtocolFrame) => void) | undefined;
  constructor(state: HubPeerStatus['state'] = 'online', generation = 1) {
    this.statusValue = { peerId: HOST, state, protocolVersion: 'fleet/1', capabilities: ['session.read', 'prompt.respond', 'pane.read'], peerProcessEpoch: 'peer-one', generation, lastHeartbeatAtMs: 1 };
  }
  status(): HubPeerStatus | undefined { return this.statusValue; }
  send(_hostId: string, frame: FleetProtocolFrame): boolean { this.sent.push(frame); this.onSend?.(frame); return true; }
  subscribeFrames(listener: (hostId: string, frame: FleetProtocolFrame) => void): () => void { this.frameListeners.add(listener); return () => this.frameListeners.delete(listener); }
  subscribeStatus(listener: (status: HubPeerStatus) => void): () => void { this.statusListeners.add(listener); return () => this.statusListeners.delete(listener); }
  frame(frame: FleetProtocolFrame): void { for (const listener of this.frameListeners) listener(HOST, frame); }
  transition(state: HubPeerStatus['state'], generation: number): void {
    const current = this.statusValue;
    if (current === undefined) throw new TypeError('status missing');
    this.statusValue = { ...current, state, generation };
    for (const listener of this.statusListeners) listener(this.statusValue);
  }
}

function successFor(frame: FleetProtocolFrame, body: string): FleetProtocolFrame {
  if (frame.kind !== 'request') throw new TypeError('request expected');
  return { kind: 'response', protocolVersion: 'fleet/1', connectionGeneration: frame.connectionGeneration, requestId: frame.requestId, target: frame.target, status: 'success', sideEffect: 'none', body };
}

test('Given an online synchronized peer, when a read responds synchronously, then subscription precedes send', async () => {
  // Given
  const channel = new Channel();
  channel.onSend = (frame) => channel.frame(successFor(frame, 'peer-value'));
  const client = new FleetReadClient(channel);

  // When
  const result = await client.history({ kind: 'session', hostId: HOST, localId: 'collision' }, { deadlineAtMs: Date.now() + 2_000, limit: 20, offset: 0, includeImages: false });

  // Then
  assert.equal(result, 'peer-value');
  assert.equal(channel.sent.length, 1);
  assert.equal(channel.frameListeners.size, 0);
  assert.equal(channel.statusListeners.size, 0);
});

test('Given a disconnect after dispatch, when a fresh synchronized generation arrives, then the safe read retries exactly once', async () => {
  // Given
  const channel = new Channel(); const client = new FleetReadClient(channel);
  let sends = 0;
  channel.onSend = (frame) => {
    sends += 1;
    if (sends === 1) channel.transition('offline', 1);
    else channel.frame(successFor(frame, 'after-reconnect'));
  };

  // When
  const pending = client.metadata({ kind: 'session', hostId: HOST, localId: 'collision' }, Date.now() + 2_000);
  channel.transition('syncing', 2);
  assert.equal(sends, 1);
  channel.transition('online', 2);
  const result = await pending;

  // Then
  assert.equal(result, 'after-reconnect');
  assert.equal(sends, 2);
  channel.transition('online', 3);
  assert.equal(sends, 2);
});

test('Given unavailable admission states or capabilities, when reads start, then no wrong-peer call is sent', async () => {
  // Given
  const cases = [
    new Channel('offline'), new Channel('syncing'), new Channel('online'),
  ];
  const online = cases[2];
  if (online?.statusValue !== undefined) online.statusValue = { ...online.statusValue, capabilities: ['catalog.read'] };

  // When / Then
  for (const channel of cases) {
    await assert.rejects(
      new FleetReadClient(channel).metadata({ kind: 'session', hostId: HOST, localId: 'collision' }, Date.now() + 2_000),
      FleetReadClientError,
    );
    assert.equal(channel.sent.length, 0);
  }
});
