import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  DiscoveryCollector,
  DiscoveryRow,
  DiscoverySnapshot,
} from '@/modules/providers/index.js';

import { fleetCatalogPaneKey } from '../catalog/keys.js';
import { parseFleetCatalogSnapshot } from '../catalog/schema.js';
import { PeerCatalogPublisher } from '../peer/catalog-publisher.js';
import { createPeerCatalogSource } from '../peer/catalog-source.js';

const HOST_ID = '00000000-0000-4000-8000-000000000023';

function snapshot(revision: number, takenAtMs: number, rows: readonly DiscoveryRow[] = []): DiscoverySnapshot {
  return {
    epoch: 'catalog-source-test', revision, takenAtMs, rows,
    health: {
      external: { ok: true, lastOkRevision: revision, consecutiveFailures: 0 },
      live: { ok: true, lastOkRevision: revision, consecutiveFailures: 0 },
    },
  };
}

/**
 * Faithful DiscoveryCollector contract double: every completed tick notifies
 * listeners (even an unchanged tick, matching the real heartbeat cadence), and
 * only a forced scan produces a tick here, mirroring an active 1 s collector
 * whose snapshot is always fresher than the 2 s staleness bound.
 */
function fakeCollector(rows: readonly DiscoveryRow[] = []): Readonly<{
  readonly collector: DiscoveryCollector;
  readonly forcedScans: () => number;
  readonly tick: () => void;
}> {
  const listeners = new Set<(value: DiscoverySnapshot) => void>();
  let forced = 0;
  let scans = 0;
  let revision = 0;
  let current = snapshot(0, 1, rows);
  const tick = (): void => {
    revision += 1;
    current = snapshot(revision, revision, rows);
    for (const listener of listeners) listener(current);
  };
  const collector: DiscoveryCollector = {
    start: () => undefined,
    stop: () => undefined,
    dispose: () => undefined,
    setActive: () => undefined,
    forceRefresh: () => undefined,
    tick: () => { tick(); return Promise.resolve(); },
    ensureFresh: (_maxAgeMs, forceFull = false) => {
      scans += 1;
      // An iteration bound, not a timer: a refresh livelock churns microtasks
      // and starves the event loop, so only a call count can name it.
      if (scans > 25) throw new Error('collector scan storm');
      if (forceFull) { forced += 1; tick(); }
      return Promise.resolve();
    },
    currentSnapshot: () => current,
    currentDetailed: () => ({ takenAtMs: current.takenAtMs, external: null, live: null }),
    onSnapshot: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return { collector, forcedScans: () => forced, tick };
}

function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out`)), 2_000);
    void promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error: unknown) => { clearTimeout(timer); reject(error instanceof Error ? error : new Error(String(error))); },
    );
  });
}

function sourceFor(collector: DiscoveryCollector) {
  return createPeerCatalogSource({
    hostId: HOST_ID, displayLabel: 'peer', capabilities: ['catalog.read'], discovery: collector,
  });
}

test('catalog source reads the collector cadence instead of forcing full scans', async () => {
  // Given: a collector whose active cadence already keeps the snapshot fresh.
  const fake = fakeCollector();
  const source = sourceFor(fake.collector);
  // When: the catalog material is read.
  await source.read();
  // Then: no forced full scan was needed to serve the read.
  assert.equal(fake.forcedScans(), 0);
});

test('catalog publisher goes idle under a continuously ticking collector', async () => {
  // Given: a hub connection accepted against a collector that notifies on every tick.
  const fake = fakeCollector();
  const source = sourceFor(fake.collector);
  const publisher = new PeerCatalogPublisher({
    epoch: 'epoch-1', read: source.read, subscribe: source.subscribe,
  });
  let published = 0;
  // When: the peer accepts the hub and the collector keeps ticking.
  const release = await bounded(publisher.accept(() => { published += 1; }), 'catalog accept');
  fake.tick();
  fake.tick();
  // Then: the snapshot event shipped and the publisher drains instead of livelocking.
  assert.equal(published, 1);
  await bounded(publisher.whenIdle(), 'publisher idle');
  assert.equal(fake.forcedScans(), 0);
  release();
  publisher.stop();
});

const TMUX = { socketPath: '/peer/tmux-1000/default', sessionId: '$1', windowId: '@1', paneId: '%1' } as const;

function discoveryRow(): DiscoveryRow {
  return {
    key: `external\0${TMUX.socketPath}\0${TMUX.sessionId}\0${TMUX.windowId}\0${TMUX.paneId}`,
    lane: 'external', tmuxName: 'fleet-collision', tmux: TMUX,
    process: { pid: 4242, startedAtMs: 1_800_000_000_000 },
    kind: 'codex', providerSessionId: '019f0000-0000-7000-8000-000000000201',
    activity: 'unknown', cwd: '/workspace', lastSeenRevision: 0, presence: 'present', staleSinceRevision: null,
  };
}

test('catalog pane localId is wire-safe and the material passes the hub schema', async () => {
  // Given: a collector row carrying the internal NUL-joined pane key.
  const fake = fakeCollector([discoveryRow()]);
  const source = sourceFor(fake.collector);
  // When: the catalog material is read.
  const material = await source.read();
  const pane = material.panes[0];
  assert.ok(pane !== undefined);
  // Then: the published key carries no NUL bytes and the snapshot schema accepts it.
  assert.equal(pane.localId.includes('\0'), false);
  assert.equal(pane.localId, fleetCatalogPaneKey(pane.lane, pane.tmux));
  const parsed = parseFleetCatalogSnapshot({ epoch: 'epoch-1', revision: 1, ...material });
  assert.equal(parsed.panes.length, 1);
});

test('catalog pane keys stay distinct when field boundaries shift', () => {
  // Given: two tmux identities whose naive concatenation would collide.
  const left = fleetCatalogPaneKey('external', { ...TMUX, socketPath: '/ab', sessionId: '$12' });
  const right = fleetCatalogPaneKey('external', { ...TMUX, socketPath: '/a', sessionId: '$123' });
  // Then: length-prefixing keeps the wire keys distinct.
  assert.notEqual(left, right);
});
