import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';

import { WebSocket as ClientWebSocket } from 'ws';

import type { DiscoveryCollector, DiscoverySnapshot } from '@/modules/providers/index.js';

import {
  DELTA_RING_SIZE,
  HEARTBEAT_CADENCE,
  MAX_BUFFERED_AMOUNT,
  MAX_QUEUED_MESSAGES,
  MAX_RESYNCS_PER_WINDOW,
  RESYNC_WINDOW_MS,
  SLOW_CLIENT_MS,
  createDiscoveryStream,
} from '../services/discovery-stream.service.js';
import { createWebSocketServer } from '../services/websocket-server.service.js';

class FakeWebSocket extends EventEmitter {
  static readonly OPEN = 1;
  readonly OPEN = 1;
  readyState = 1;
  bufferedAmount = 0;
  readonly sent: string[] = [];
  closeCode: number | undefined;
  send(message: string): void { this.sent.push(message); }
  close(code?: number): void { this.closeCode = code; this.readyState = 3; }
}

function snapshot(revision: number, epoch = 'epoch'): DiscoverySnapshot {
  return {
    epoch, revision, takenAtMs: revision, rows: [{
      key: 'external\0socket\0session\0window\0pane', lane: 'external', tmuxName: 'tmux',
      tmux: { socketPath: '/socket', sessionId: '$1', windowId: '@1', paneId: '%1' },
      process: { pid: 1, startedAtMs: 1 }, kind: 'claude', providerSessionId: null,
      activity: 'running', cwd: null, lastSeenRevision: revision, presence: 'present', staleSinceRevision: null,
    }],
    health: {
      external: { ok: true, lastOkRevision: revision, consecutiveFailures: 0 },
      live: { ok: true, lastOkRevision: revision, consecutiveFailures: 0 },
    },
  };
}

function collector(initial = snapshot(1), onStart?: () => void) {
  let current = initial;
  const listeners = new Set<(next: DiscoverySnapshot) => void>();
  let starts = 0;
  let stops = 0;
  let active = false;
  const instance: DiscoveryCollector = {
    start: () => { starts += 1; onStart?.(); },
    stop: () => { stops += 1; },
    dispose: () => undefined,
    setActive: (next) => { active = next; },
    forceRefresh: () => undefined,
    tick: async () => undefined,
    currentSnapshot: () => current,
    onSnapshot: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
  };
  return {
    instance,
    emit(next: DiscoverySnapshot) { current = next; for (const listener of listeners) listener(next); },
    starts: () => starts,
    stops: () => stops,
    active: () => active,
  };
}

function frames(ws: FakeWebSocket): Record<string, unknown>[] { return ws.sent.map((frame) => JSON.parse(frame) as Record<string, unknown>); }
function subscribe(stream: ReturnType<typeof createDiscoveryStream>, ws: FakeWebSocket, known?: Record<string, unknown>): void {
  stream.handle(ws as never, { type: 'discovery.subscribe', protocolVersion: 1, ...(known === undefined ? {} : { known }) });
}

test('subscribes with full snapshot then preserves delta order and omits internal paths', () => {
  const source = collector(); const stream = createDiscoveryStream(source.instance); const ws = new FakeWebSocket();
  subscribe(stream, ws); source.emit(snapshot(2)); source.emit(snapshot(3));
  const events = frames(ws);
  assert.deepEqual(events.map((event) => event.kind), ['discovery.snapshot', 'discovery.delta', 'discovery.delta']);
  assert.deepEqual(events.map((event) => event.revision), [1, 2, 3]);
  assert.equal(ws.sent.join('\n').includes('transcriptPaths'), false);
  assert.equal(ws.sent.join('\n').includes('/socket'), true, 'existing tmux identity socket field remains unchanged');
  stream.dispose();
});

test('replays only missed revisions, restarts on epoch change, and resyncs unavailable replay', () => {
  const source = collector(); const stream = createDiscoveryStream(source.instance);
  source.emit(snapshot(2)); source.emit(snapshot(3));
  const replay = new FakeWebSocket(); subscribe(stream, replay, { epoch: 'epoch', revision: 1 });
  assert.deepEqual(frames(replay).map((event) => event.revision), [2, 3]);
  const epochChanged = new FakeWebSocket(); subscribe(stream, epochChanged, { epoch: 'old', revision: 3 });
  assert.equal(frames(epochChanged)[0]?.kind, 'discovery.snapshot');
  for (let revision = 4; revision < DELTA_RING_SIZE + 8; revision += 1) source.emit(snapshot(revision));
  const stale = new FakeWebSocket(); subscribe(stream, stale, { epoch: 'epoch', revision: 1 });
  assert.deepEqual(frames(stale).map((event) => event.kind), ['discovery.resync_required', 'discovery.snapshot']);
  stream.dispose();
});

test('snapshot baseline excludes duplicate races and collector transitions to idle after the final unsubscribe', () => {
  const source = collector(snapshot(1), () => source.emit(snapshot(2)));
  const stream = createDiscoveryStream(source.instance); const ws = new FakeWebSocket();
  assert.equal(source.starts(), 0); subscribe(stream, ws);
  assert.deepEqual(frames(ws).map((event) => event.kind), ['discovery.snapshot', 'discovery.delta']);
  assert.deepEqual(frames(ws).map((event) => event.revision), [1, 2]);
  stream.handle(ws as never, { type: 'discovery.unsubscribe' });
  assert.equal(source.starts(), 1); assert.equal(source.stops(), 0); assert.equal(source.active(), false);
  stream.dispose();
});

test('bounded queue emits resync without oversized payload and closes only sustained slow clients', () => {
  let clock = 0; const source = collector(); const stream = createDiscoveryStream(source.instance, () => clock); const ws = new FakeWebSocket();
  ws.bufferedAmount = MAX_BUFFERED_AMOUNT + 1; subscribe(stream, ws);
  for (let revision = 2; revision <= MAX_QUEUED_MESSAGES + 3; revision += 1) source.emit(snapshot(revision));
  ws.bufferedAmount = 0; source.emit(snapshot(MAX_QUEUED_MESSAGES + 4));
  assert.equal(frames(ws)[0]?.kind, 'discovery.resync_required');
  assert.ok(ws.sent[0]!.length < 256);
  clock = 0; ws.bufferedAmount = MAX_BUFFERED_AMOUNT + 1; source.emit(snapshot(100)); assert.equal(ws.closeCode, undefined);
  clock = SLOW_CLIENT_MS - 1; source.emit(snapshot(101)); assert.equal(ws.closeCode, undefined);
  clock = SLOW_CLIENT_MS; source.emit(snapshot(102)); assert.equal(ws.closeCode, 1013);
  stream.dispose();
});
test('exact-known subscriptions receive one heartbeat, unchanged ticks heartbeat every cadence, and resync is rate-limited', () => {
  let clock = 0;
  const source = collector();
  const stream = createDiscoveryStream(source.instance, () => clock);
  const ws = new FakeWebSocket();
  subscribe(stream, ws, { epoch: 'epoch', revision: 1 });
  assert.deepEqual(frames(ws).map((event) => event.kind), ['discovery.heartbeat']);

  for (let tick = 0; tick < HEARTBEAT_CADENCE; tick += 1) source.emit(snapshot(1));
  assert.deepEqual(frames(ws).map((event) => event.kind), ['discovery.heartbeat', 'discovery.heartbeat']);

  for (let request = 0; request < MAX_RESYNCS_PER_WINDOW; request += 1) {
    stream.handle(ws as never, { type: 'discovery.resync', reason: 'gap' });
  }
  assert.equal(ws.closeCode, undefined);
  stream.handle(ws as never, { type: 'discovery.resync', reason: 'gap' });
  assert.equal(ws.closeCode, 1008);

  const second = new FakeWebSocket();
  subscribe(stream, second);
  for (let request = 0; request < MAX_RESYNCS_PER_WINDOW; request += 1) {
    stream.handle(second as never, { type: 'discovery.resync', reason: 'gap' });
  }
  clock = RESYNC_WINDOW_MS + 1;
  stream.handle(second as never, { type: 'discovery.resync', reason: 'gap' });
  assert.equal(second.closeCode, undefined);
  stream.dispose();
});

test('unauthenticated websocket upgrades cannot subscribe to discovery', async () => {
  const source = collector(); const server = createServer();
  const wss = createWebSocketServer(server, {
    verifyClient: { authenticateWebSocket: () => null },
    discovery: source.instance,
  } as never);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const status = await new Promise<number>((resolve, reject) => {
    const client = new ClientWebSocket(`ws://127.0.0.1:${address.port}/ws`);
    client.once('unexpected-response', (_request, response) => { response.resume(); resolve(response.statusCode ?? 0); });
    client.once('error', reject);
  });
  assert.equal(status, 401);
  assert.equal(source.starts(), 0);
  await new Promise<void>((resolve, reject) => wss.close((error) => error ? reject(error) : resolve()));
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});
test('malformed pane subscriptions emit protocol errors without starting capture timers', async () => {
  let starts = 0;
  const panes = {
    validateSubscription: () => { throw new Error('invalid pane subscription'); },
    start: () => { starts += 1; },
    subscribe: async () => undefined,
    unsubscribe: () => undefined,
    close: () => undefined,
    reconcile: () => undefined,
    dispose: () => undefined,
  };
  const server = createServer();
  const wss = createWebSocketServer(server, {
    verifyClient: { authenticateWebSocket: () => ({ id: 1, username: 'test' }) },
    panes,
  } as never);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const client = new ClientWebSocket(`ws://127.0.0.1:${address.port}/ws`);
  await new Promise<void>((resolve, reject) => {
    client.once('open', resolve);
    client.once('error', reject);
  });
  const error = new Promise<Record<string, unknown>>((resolve, reject) => {
    client.once('message', (frame) => resolve(JSON.parse(String(frame)) as Record<string, unknown>));
    client.once('error', reject);
  });
  client.send(JSON.stringify({ type: 'pane.subscribe', protocolVersion: 2 }));
  const message = await error;
  assert.equal(message.kind, 'protocol_error');
  assert.equal(message.code, 'INVALID_PANE_SUBSCRIPTION');
  assert.equal(message.error, 'invalid pane subscription');
  assert.equal(message.sessionId, null);
  assert.equal(typeof message.timestamp, 'string');
  assert.equal(starts, 0);
  client.close();
  await new Promise<void>((resolve, reject) => wss.close((failure) => failure ? reject(failure) : resolve()));
  await new Promise<void>((resolve, reject) => server.close((failure) => failure ? reject(failure) : resolve()));
});
