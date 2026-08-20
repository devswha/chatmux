import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';

import { WebSocket as ClientWebSocket } from 'ws';

import type { DiscoveryCollector, DiscoverySnapshot } from '@/modules/providers/index.js';

import {
  HEARTBEAT_CADENCE,
  MAX_BUFFERED_AMOUNT,
  MAX_QUEUED_MESSAGES,
  MAX_RESYNCS_PER_WINDOW,
  RESYNC_WINDOW_MS,
  SLOW_CLIENT_MS,
  createDiscoveryStream,
  projectDiscoveryV2,
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
    v2: {
      version: 2,
      epoch: `runtime-${epoch}`,
      globalRevision: revision,
      terminals: [],
      sourceDescriptors: [{ runtime: 'tmux', sourceId: 'tmux', readiness: 'ready' }],
      sourceLanes: [],
      coverageByLane: {
        external: { lane: 'external', state: 'complete', expectedSourceLaneKeys: [], authoritativeSourceLaneKeys: [], retainedSourceLaneKeys: [], unavailableSourceLaneKeys: [] },
        live: { lane: 'live', state: 'complete', expectedSourceLaneKeys: [], authoritativeSourceLaneKeys: [], retainedSourceLaneKeys: [], unavailableSourceLaneKeys: [] },
      },
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
    ensureFresh: async () => undefined,
    currentSnapshot: () => current,
    currentDetailed: () => ({ takenAtMs: null, external: null, live: null }),
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
function subscribe(
  stream: ReturnType<typeof createDiscoveryStream>,
  ws: FakeWebSocket,
  known?: Record<string, unknown>,
  lanes?: readonly ('external' | 'live')[],
): void {
  stream.handle(ws as never, {
    type: 'discovery.subscribe',
    protocolVersion: 2,
    ...(known === undefined ? {} : { known }),
    ...(lanes === undefined ? {} : { lanes }),
  });
}

test('subscribes with v2 snapshots and preserves revision order without legacy rows', () => {
  const source = collector(); const stream = createDiscoveryStream(source.instance); const ws = new FakeWebSocket();
  subscribe(stream, ws); source.emit(snapshot(2)); source.emit(snapshot(3));
  const events = frames(ws);
  assert.deepEqual(events.map((event) => event.kind), ['discovery.v2.snapshot', 'discovery.v2.snapshot', 'discovery.v2.snapshot']);
  assert.deepEqual(events.map((event) => (event.discovery as { globalRevision: number }).globalRevision), [1, 2, 3]);
  assert.equal(ws.sent.join('\n').includes('transcriptPaths'), false);
  stream.dispose();
});
test('projects snapshots and resyncs to exactly the requested discovery lanes', () => {
  const mixed = snapshot(1);
  const discovery = mixed.v2!;
  discovery.terminals = [
    { lane: 'external', terminal: { runtime: 'tmux', tmux: { socketPath: '/socket', sessionId: '$1', windowId: '@1', paneId: '%1' }, process: { pid: 1, startedAtMs: 1 }, targetClass: 'local-agent' } },
    { lane: 'external', terminal: { runtime: 'herdr', sourceId: 'herdr-external', targetId: 'target-external', process: { pid: 2, startedAtMs: 2 }, targetClass: 'local-agent' } },
    { lane: 'live', terminal: { runtime: 'herdr', sourceId: 'herdr-live', targetId: 'target-live', process: { pid: 3, startedAtMs: 3 }, targetClass: 'local-agent' } },
  ];
  discovery.tmuxRows = [
    { key: 'external-tmux', lane: 'external', tmuxName: 'tmux', tmux: { socketPath: '/socket', sessionId: '$1', windowId: '@1', paneId: '%1' }, process: { pid: 1, startedAtMs: 1 }, kind: 'claude', providerSessionId: null, activity: 'running', cwd: null, presence: 'present' },
    { key: 'live-tmux', lane: 'live', tmuxName: 'tmux', tmux: { socketPath: '/socket', sessionId: '$2', windowId: '@2', paneId: '%2' }, process: { pid: 4, startedAtMs: 4 }, kind: 'claude', providerSessionId: null, activity: 'running', cwd: null, presence: 'present' },
  ];
  discovery.sourceDescriptors = [
    { runtime: 'tmux', sourceId: 'tmux.local', readiness: 'ready' },
    { runtime: 'herdr', sourceId: 'herdr-external', readiness: 'ready' },
    { runtime: 'herdr', sourceId: 'herdr-live', readiness: 'ready' },
  ];
  discovery.sourceLanes = [
    { lane: 'external', sourceId: 'tmux.local', runtime: 'tmux', readiness: 'ready', capabilities: { discovery: true, output: true, actions: true, attach: true, create: false }, sourceLaneRevision: 1, lastOkGlobalRevision: 1, coverage: 'authoritative', consecutiveFailures: 0 },
    { lane: 'external', sourceId: 'herdr-external', runtime: 'herdr', readiness: 'ready', capabilities: { discovery: true, output: true, actions: true, attach: true, create: false }, sourceLaneRevision: 1, lastOkGlobalRevision: 1, coverage: 'authoritative', consecutiveFailures: 0 },
    { lane: 'live', sourceId: 'herdr-live', runtime: 'herdr', readiness: 'ready', capabilities: { discovery: true, output: true, actions: true, attach: true, create: false }, sourceLaneRevision: 1, lastOkGlobalRevision: 1, coverage: 'authoritative', consecutiveFailures: 0 },
  ];
  discovery.coverageByLane.external = { lane: 'external', state: 'complete', expectedSourceLaneKeys: ['external\u0000tmux.local', 'external\u0000herdr-external'], authoritativeSourceLaneKeys: ['external\u0000tmux.local', 'external\u0000herdr-external'], retainedSourceLaneKeys: [], unavailableSourceLaneKeys: [] };
  discovery.coverageByLane.live = { lane: 'live', state: 'complete', expectedSourceLaneKeys: ['live\u0000herdr-live'], authoritativeSourceLaneKeys: ['live\u0000herdr-live'], retainedSourceLaneKeys: [], unavailableSourceLaneKeys: [] };

  const projected = projectDiscoveryV2(discovery, ['external']);
  assert.deepEqual(projected.terminals.map((entry) => entry.lane), ['external', 'external']);
  assert.deepEqual(projected.tmuxRows?.map((row) => row.lane), ['external']);
  assert.deepEqual(projected.sourceLanes.map((source) => source.lane), ['external', 'external']);
  assert.deepEqual(projected.sourceDescriptors.map((source) => source.sourceId), ['tmux.local', 'herdr-external']);
  assert.deepEqual(Object.keys(projected.coverageByLane), ['external', 'live']);
  assert.equal(projected.coverageByLane.live.state, 'unavailable');
  assert.deepEqual(projected.coverageByLane.live.expectedSourceLaneKeys, []);

  const source = collector(mixed); const stream = createDiscoveryStream(source.instance); const ws = new FakeWebSocket();
  subscribe(stream, ws, undefined, ['external']);
  stream.handle(ws as never, { type: 'discovery.resync', reason: 'gap' });
  const snapshots = frames(ws).filter((event) => event.kind === 'discovery.v2.snapshot');
  assert.equal(snapshots.length, 2);
  assert.deepEqual((snapshots[1]!.discovery as { terminals: Array<{ lane: string }> }).terminals.map((entry) => entry.lane), ['external', 'external']);
  stream.dispose();
});
test('shared sockets union external and live subscriptions in either order', () => {
  const mixed = snapshot(1);
  mixed.v2!.terminals = [
    { lane: 'external', terminal: { runtime: 'herdr', sourceId: 'herdr-external', targetId: 'target-external', process: { pid: 2, startedAtMs: 2 }, targetClass: 'local-agent' } },
    { lane: 'live', terminal: { runtime: 'herdr', sourceId: 'herdr-live', targetId: 'target-live', process: { pid: 3, startedAtMs: 3 }, targetClass: 'local-agent' } },
  ];
  for (const lanes of [['external', 'live'], ['live', 'external']] as const) {
    const source = collector(mixed);
    const stream = createDiscoveryStream(source.instance);
    const ws = new FakeWebSocket();
    subscribe(stream, ws, { epoch: 'runtime-epoch', globalRevision: 1 }, [lanes[0]]);
    subscribe(stream, ws, { epoch: 'runtime-epoch', globalRevision: 1 }, [lanes[1]]);
    const final = frames(ws)[frames(ws).length - 1]!;
    assert.equal(final.kind, 'discovery.v2.snapshot');
    assert.deepEqual((final.discovery as { terminals: Array<{ lane: string }> }).terminals.map((entry) => entry.lane).sort(), ['external', 'live']);
    stream.dispose();
  }
});

test('exact known revision heartbeats while epoch or revision changes receive a snapshot', () => {
  const source = collector(); const stream = createDiscoveryStream(source.instance);
  const exact = new FakeWebSocket(); subscribe(stream, exact, { epoch: 'runtime-epoch', globalRevision: 1 });
  assert.equal(frames(exact)[0]?.kind, 'discovery.v2.heartbeat');
  const changed = new FakeWebSocket(); subscribe(stream, changed, { epoch: 'old', globalRevision: 1 });
  assert.equal(frames(changed)[0]?.kind, 'discovery.v2.snapshot');
  stream.dispose();
});

test('subscription start races remain ordered and final unsubscribe makes the collector idle', () => {
  const source = collector(snapshot(1), () => source.emit(snapshot(2)));
  const stream = createDiscoveryStream(source.instance); const ws = new FakeWebSocket();
  assert.equal(source.starts(), 0); subscribe(stream, ws);
  assert.deepEqual(frames(ws).map((event) => event.kind), ['discovery.v2.snapshot', 'discovery.v2.snapshot']);
  assert.deepEqual(frames(ws).map((event) => ((event.discovery as { globalRevision: number }).globalRevision)), [1, 2]);
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
test('queue overflow suppresses stale snapshots until the client resyncs', () => {
  const source = collector();
  const stream = createDiscoveryStream(source.instance);
  const ws = new FakeWebSocket();
  ws.bufferedAmount = MAX_BUFFERED_AMOUNT + 1;
  subscribe(stream, ws);

  for (let revision = 2; revision <= MAX_QUEUED_MESSAGES + 3; revision += 1) {
    source.emit(snapshot(revision));
  }

  ws.bufferedAmount = 0;
  source.emit(snapshot(MAX_QUEUED_MESSAGES + 4));
  source.emit(snapshot(MAX_QUEUED_MESSAGES + 5));
  assert.deepEqual(frames(ws).map((event) => event.kind), ['discovery.resync_required']);

  stream.handle(ws as never, { type: 'discovery.resync', reason: 'queue_overflow' });
  assert.deepEqual(frames(ws).map((event) => event.kind), [
    'discovery.resync_required',
    'discovery.v2.snapshot',
  ]);

  source.emit(snapshot(MAX_QUEUED_MESSAGES + 6));
  assert.deepEqual(frames(ws).map((event) => event.kind), [
    'discovery.resync_required',
    'discovery.v2.snapshot',
    'discovery.v2.snapshot',
  ]);
  stream.dispose();
});
test('unchanged ticks heartbeat every cadence and resync is rate-limited', () => {
  let clock = 0;
  const source = collector();
  const stream = createDiscoveryStream(source.instance, () => clock);
  const ws = new FakeWebSocket();
  subscribe(stream, ws, { epoch: 'runtime-epoch', globalRevision: 1 });
  assert.deepEqual(frames(ws).map((event) => event.kind), ['discovery.v2.heartbeat']);

  for (let tick = 0; tick < HEARTBEAT_CADENCE; tick += 1) source.emit(snapshot(1));
  assert.deepEqual(frames(ws).map((event) => event.kind), ['discovery.v2.heartbeat', 'discovery.v2.heartbeat']);

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

test('legacy discovery clients receive reload-required and never become subscribers', () => {
  const source = collector();
  const stream = createDiscoveryStream(source.instance);
  const ws = new FakeWebSocket();
  stream.handle(ws as never, { type: 'discovery.subscribe', protocolVersion: 1 });
  assert.deepEqual(frames(ws).map((event) => [event.kind, event.code]), [['protocol_error', 'CLIENT_RELOAD_REQUIRED']]);
  assert.equal(stream.subscriberCount(), 0);
  assert.equal(source.starts(), 0);
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
test('chat connections receive a server_hello identity frame before any other traffic', async () => {
  const server = createServer();
  const wss = createWebSocketServer(server, {
    verifyClient: { authenticateWebSocket: () => ({ id: 1, username: 'test' }) },
    serverInfo: { version: '9.9.9', bootId: 'boot-hello' },
  } as never);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const client = new ClientWebSocket(`ws://127.0.0.1:${address.port}/ws`);
  const first = await new Promise<Record<string, unknown>>((resolve, reject) => {
    client.once('message', (frame) => resolve(JSON.parse(String(frame)) as Record<string, unknown>));
    client.once('error', reject);
  });
  assert.equal(first.kind, 'server_hello');
  assert.equal(first.serverVersion, '9.9.9');
  assert.equal(first.bootId, 'boot-hello');
  client.close();
  await new Promise<void>((resolve, reject) => wss.close((error) => error ? reject(error) : resolve()));
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});
test('malformed pane subscriptions emit protocol errors without starting capture timers', async () => {
  let starts = 0;
  const panes = {
    validateSubscription: (data: Record<string, unknown>) => {
      if (data.protocolVersion !== 2) throw new Error('CLIENT_RELOAD_REQUIRED');
      throw new Error('invalid pane subscription');
    },
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
  const reloadError = new Promise<Record<string, unknown>>((resolve, reject) => {
    client.once('message', (frame) => resolve(JSON.parse(String(frame)) as Record<string, unknown>));
    client.once('error', reject);
  });
  client.send(JSON.stringify({ type: 'pane.subscribe', protocolVersion: 1 }));
  const reloadMessage = await reloadError;
  assert.equal(reloadMessage.code, 'CLIENT_RELOAD_REQUIRED');
  assert.equal(reloadMessage.reloadRequired, true);
  assert.equal(starts, 0);
  client.close();
  await new Promise<void>((resolve, reject) => wss.close((failure) => failure ? reject(failure) : resolve()));
  await new Promise<void>((resolve, reject) => server.close((failure) => failure ? reject(failure) : resolve()));
});
test('runtime discovery v2 is explicitly versioned and rejects legacy authority fallback', () => {
  const initial: DiscoverySnapshot = {
    ...snapshot(1),
    v2: {
      version: 2,
      epoch: 'runtime-epoch',
      globalRevision: 1,
      terminals: [],
      sourceDescriptors: [{ runtime: 'tmux', sourceId: 'tmux', readiness: 'ready' }],
      sourceLanes: [],
      coverageByLane: {
        external: { lane: 'external', state: 'complete', expectedSourceLaneKeys: [], authoritativeSourceLaneKeys: [], retainedSourceLaneKeys: [], unavailableSourceLaneKeys: [] },
        live: { lane: 'live', state: 'complete', expectedSourceLaneKeys: [], authoritativeSourceLaneKeys: [], retainedSourceLaneKeys: [], unavailableSourceLaneKeys: [] },
      },
    },
  };
  const source = collector(initial);
  const stream = createDiscoveryStream(source.instance);
  const ws = new FakeWebSocket();
  stream.handle(ws as never, { type: 'discovery.subscribe', protocolVersion: 2 });
  const event = frames(ws)[0]!;
  assert.equal(event.kind, 'discovery.v2.snapshot');
  assert.equal(event.version, 2);
  assert.equal(JSON.stringify(event).includes('/socket'), false);
  stream.dispose();

  const noV2: DiscoverySnapshot = { ...snapshot(1), v2: undefined };
  const unavailable = createDiscoveryStream(collector(noV2).instance);
  const rejected = new FakeWebSocket();
  unavailable.handle(rejected as never, { type: 'discovery.subscribe', protocolVersion: 2 });
  assert.equal(frames(rejected)[0]?.code, 'RUNTIME_DISCOVERY_UNAVAILABLE');
  unavailable.dispose();
});
