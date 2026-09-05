import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import TestRenderer, { act } from 'react-test-renderer';

import type { ServerEvent } from '../contexts/WebSocketContext';

import { DISCOVERY_STALE_MS } from './discoveryReconciliation';
import { useDiscoveryStream, type DiscoveryLane, type DiscoveryRow } from './useDiscoveryStream';

const snapshot = (revision = 1, epoch = 'epoch-1', liveOk = true): ServerEvent => ({
  kind: 'discovery.snapshot', epoch, revision, rows: [],
  health: {
    external: { ok: true, lastOkRevision: revision },
    live: { ok: liveOk, lastOkRevision: revision },
  },
});
const delta = (revision: number, prevRevision = revision - 1, epoch = 'epoch-1'): ServerEvent => ({
  ...snapshot(revision, epoch), kind: 'discovery.delta', prevRevision, changes: [],
});
const heartbeat = (revision = 1, epoch = 'epoch-1'): ServerEvent => ({
  kind: 'discovery.heartbeat', epoch, revision,
});

async function harness(t: TestContext, laneGroups: DiscoveryLane[][] = [['external', 'live']]) {
  let now = 1_000;
  t.mock.method(Date, 'now', () => now);
  const originals = ['window', 'document'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  const timers = new Map<number, () => void>();
  const visibilityListeners = new Set<() => void>();
  let timerId = 0;
  const browserDocument = {
    visibilityState: 'visible',
    addEventListener: (_event: string, callback: () => void) => visibilityListeners.add(callback),
    removeEventListener: (_event: string, callback: () => void) => visibilityListeners.delete(callback),
  };
  Object.defineProperty(globalThis, 'document', { configurable: true, value: browserDocument });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      setInterval(callback: () => void, ms: number) {
        assert.equal(ms, DISCOVERY_STALE_MS, 'only the existing expiry timer is installed');
        timers.set(++timerId, callback);
        return timerId;
      },
      clearInterval: (id: number) => timers.delete(id),
    },
  });
  const frames: unknown[] = [];
  const listeners = new Set<(event: ServerEvent) => void>();
  const latest: ReturnType<typeof useDiscoveryStream>[] = [];
  const rows: DiscoveryRow[][] = [];
  const sendMessage = (frame: unknown) => { frames.push(frame); };
  const subscribe = (listener: (event: ServerEvent) => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  };
  function Probe({ connected, index }: { connected: boolean; index: number }) {
    latest[index] = useDiscoveryStream({
      lanes: laneGroups[index], isConnected: connected, sendMessage, subscribe,
      onRows: (next) => rows.push(next),
    });
    return null;
  }
  const tree = (connected: boolean) => <>{laneGroups.map((_, index) => <Probe key={index} connected={connected} index={index} />)}</>;
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(tree(true)); });
  t.after(async () => {
    await act(async () => renderer.unmount());
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  return {
    frames, rows, latest, listeners, visibilityListeners, timers,
    advance: (ms: number) => { now += ms; },
    emit: (event: ServerEvent) => act(async () => { for (const listener of [...listeners]) listener(event); }),
    connect: (connected: boolean) => act(async () => renderer.update(tree(connected))),
    visibility: (state: 'visible' | 'hidden') => act(async () => {
      browserDocument.visibilityState = state;
      for (const listener of [...visibilityListeners]) listener();
    }),
    expire: () => act(async () => { for (const callback of timers.values()) callback(); }),
    unmount: () => act(async () => renderer.unmount()),
  };
}

test('socket open and heartbeat cannot establish current discovery; reconnect requests a full snapshot', async (t) => {
  const h = await harness(t);
  const subscribe = { type: 'discovery.subscribe', protocolVersion: 1, lanes: ['external', 'live'], known: null };
  assert.deepEqual(h.frames, [subscribe]);
  assert.equal(h.latest[0].freshness, 'refreshing');
  await h.emit(heartbeat());
  assert.equal(h.latest[0].streamHealthy, false);
  assert.equal(h.latest[0].freshness, 'refreshing');
  await h.emit(snapshot());
  assert.equal(h.latest[0].freshness, 'current');

  await h.connect(false);
  assert.equal(h.latest[0].freshness, 'reconnecting');
  assert.equal(h.latest[0].streamHealthy, false);
  await h.emit(snapshot(2));
  await h.emit({ kind: 'websocket_reconnected' });
  await h.visibility('hidden');
  h.advance(DISCOVERY_STALE_MS + 1);
  await h.visibility('visible');
  assert.deepEqual(h.frames, [subscribe], 'disconnected hooks send no frames');
  await h.connect(true);
  assert.deepEqual(h.frames, [subscribe, subscribe]);
  assert.equal(h.latest[0].freshness, 'refreshing');
  await h.emit(heartbeat());
  assert.equal(h.latest[0].freshness, 'refreshing');
  await h.emit(snapshot());
  assert.equal(h.latest[0].freshness, 'current');
});

test('foreground reconciles stale discovery once across lane consumers and ignores repeated visible events', async (t) => {
  const h = await harness(t, [['external'], ['live']]);
  assert.equal(h.frames.length, 1, 'initial lane subscriptions share the pending snapshot');
  await h.emit(snapshot());
  await h.visibility('hidden');
  h.advance(1_000);
  await h.visibility('visible');
  assert.equal(h.frames.length, 1, 'a fresh foreground transition needs no read');
  await h.visibility('hidden');
  h.advance(DISCOVERY_STALE_MS + 1);
  await h.visibility('visible');
  assert.equal(h.frames.length, 2);
  assert.deepEqual(h.frames[1], { type: 'discovery.resync', reason: 'client_error' });
  assert.deepEqual(h.latest.map((state) => state.freshness), ['refreshing', 'refreshing']);
  await h.visibility('visible');
  await h.visibility('hidden');
  await h.visibility('visible');
  await h.emit(heartbeat());
  await h.emit(delta(2));
  assert.equal(h.frames.length, 2, 'pending recovery is not amplified by visibility, heartbeat or deltas');
  assert.equal(h.latest[0].freshness, 'refreshing');
  await h.emit(snapshot(2));
  assert.deepEqual(h.latest.map((state) => state.freshness), ['current', 'current']);
});

test('healthy frames received in the background avoid unnecessary foreground reconciliation', async (t) => {
  const h = await harness(t);
  await h.emit(snapshot());
  await h.visibility('hidden');
  for (let tick = 0; tick < 5; tick += 1) {
    h.advance(5_000);
    await h.emit(heartbeat());
  }
  await h.visibility('visible');
  assert.equal(h.frames.length, 1);
  assert.equal(h.latest[0].freshness, 'current');
});

test('gap, epoch mismatch and server resync notices coalesce until snapshot recovery', async (t) => {
  const h = await harness(t, [['external'], ['live']]);
  await h.emit(snapshot());
  const published = h.rows.length;
  await h.emit(delta(3, 2));
  await h.emit(delta(4, 3));
  await h.emit({ kind: 'discovery.resync_required' });
  await h.emit(delta(2, 1, 'epoch-2'));
  assert.equal(h.rows.length, published, 'out-of-order frames never update displayed rows');
  assert.deepEqual(h.frames.slice(1), [{ type: 'discovery.resync', reason: 'gap' }]);
  assert.equal(h.latest[0].freshness, 'refreshing');
  await h.emit(snapshot(1, 'epoch-2'));
  assert.equal(h.latest[0].freshness, 'current');
  await h.emit(delta(2, 1, 'epoch-3'));
  assert.deepEqual(h.frames.at(-1), { type: 'discovery.resync', reason: 'epoch_mismatch' });
});

test('repeated noncontiguous deltas coalesce a gap resync; heartbeat can reveal a lost final delta', async (t) => {
  const h = await harness(t);
  await h.emit(snapshot());
  await h.emit(delta(2));
  const published = h.rows.length;
  await h.emit(snapshot(1));
  assert.equal(h.rows.length, published);
  assert.equal(h.frames.length, 1);
  await h.emit(delta(2));
  await h.emit(delta(1, 0));
  assert.equal(h.rows.length, published);
  assert.deepEqual(h.frames.slice(1), [{ type: 'discovery.resync', reason: 'gap' }]);
  await h.emit(snapshot(2));
  await h.emit(heartbeat(3));
  assert.equal(h.frames.length, 3);
  assert.deepEqual(h.frames.at(-1), { type: 'discovery.resync', reason: 'gap' });
  assert.equal(h.latest[0].freshness, 'refreshing');
});

test('current status requires healthy evidence for both local lanes and ignores remote catalog events', async (t) => {
  const h = await harness(t, [['external']]);
  await h.emit(snapshot(1, 'epoch-1', false));
  assert.equal(h.latest[0].streamHealthy, true, 'external lane authority stays independent');
  assert.equal(h.latest[0].freshness, 'unavailable');
  await h.emit({ kind: 'fleet.catalog.snapshot', state: 'online' });
  await h.emit(heartbeat());
  assert.equal(h.latest[0].freshness, 'unavailable');
  await h.visibility('hidden');
  await h.visibility('visible');
  assert.equal(h.latest[0].freshness, 'refreshing');
  await h.emit(snapshot(2));
  assert.equal(h.latest[0].freshness, 'current');
  h.advance(DISCOVERY_STALE_MS + 1);
  await h.expire();
  assert.equal(h.latest[0].freshness, 'unavailable');
  assert.equal(h.latest[0].streamHealthy, false);
  const frames = h.frames.length;
  await h.expire();
  await h.emit(heartbeat(2));
  assert.equal(h.frames.length, frames, 'expiry does not create a polling loop');
  assert.equal(h.latest[0].freshness, 'unavailable');
});

test('expired reads retry only on another foreground transition and stay below the server resync limit', async (t) => {
  const h = await harness(t);
  await h.emit(snapshot());
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await act(async () => h.latest[0].refresh());
    await h.emit(snapshot(attempt + 2));
  }
  assert.equal(h.frames.length, 3, 'at most two resyncs in one ten-second window');
  await h.visibility('hidden');
  h.advance(DISCOVERY_STALE_MS + 1);
  await h.visibility('visible');
  assert.equal(h.frames.length, 4);
  await h.visibility('hidden');
  h.advance(DISCOVERY_STALE_MS + 1);
  await h.visibility('visible');
  assert.equal(h.frames.length, 5, 'an expired pending read may be retried once on return');
});

test('reconnect notifications are shared and cleanup removes foreground listeners and fences queued frames', async (t) => {
  const h = await harness(t, [['external'], ['live']]);
  await h.emit(snapshot());
  await h.emit({ kind: 'websocket_reconnected' });
  assert.equal(h.frames.length, 2);
  assert.equal(h.latest[0].freshness, 'refreshing');
  const queued = [...h.listeners];
  await h.unmount();
  assert.equal(h.listeners.size, 0);
  assert.equal(h.visibilityListeners.size, 0);
  assert.equal(h.timers.size, 0);
  const published = h.rows.length;
  for (const callback of queued) callback(snapshot(2));
  await h.visibility('hidden');
  await h.visibility('visible');
  assert.equal(h.frames.length, 2);
  assert.equal(h.rows.length, published);
});
