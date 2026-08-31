import assert from 'node:assert/strict';
import test from 'node:test';

import { FleetCatalogAggregator } from '../catalog/aggregator.js';
import {
  MAX_FLEET_CATALOG_DELTA_CHANGES,
  MAX_FLEET_CATALOG_ROWS_PER_ENTITY,
} from '../catalog/schema.js';
import type { FleetCatalogDelta, FleetCatalogMaterial, FleetCatalogSnapshot } from '../catalog/types.js';
import { PeerCatalogPublisher } from '../peer/catalog-publisher.js';

const A = '10000000-0000-4000-8000-000000000001';
const B = '20000000-0000-4000-8000-000000000002';
function material(hostId = A, activity = 'unknown', healthy = true): FleetCatalogMaterial {
  return {
    host: { hostId, displayLabel: `host-${hostId[0]}`, capabilities: ['catalog.read'] },
    projects: [{ localId: 'project', path: '/same', displayName: 'same', isStarred: false }],
    sessions: [{ localId: 'session', projectLocalId: 'project', provider: 'codex', summary: 'same', lastActivityMs: 10 }],
    panes: [{ localId: 'pane', lane: 'external', tmuxName: 'same', tmux: { socketPath: '/tmp/same', sessionId: '$1', windowId: '@1', paneId: '%1' }, process: { pid: 10, startedAtMs: 100 }, kind: 'codex', providerSessionId: 'provider', activity, cwd: '/same', presence: 'present' }],
    health: { external: { ok: true, lastOkRevision: 1, consecutiveFailures: 0 }, live: { ok: healthy, lastOkRevision: healthy ? 1 : null, consecutiveFailures: healthy ? 0 : 30 } },
    processing: [{ localId: 'session', provider: 'codex', startedAtMs: 20, lastSeq: 2 }],
  };
}
function snapshot(hostId = A, epoch = 'epoch-1', revision = 1): FleetCatalogSnapshot { return { epoch, revision, ...material(hostId) }; }
function delta(base: FleetCatalogSnapshot, revision: number, changes: FleetCatalogDelta['changes']): FleetCatalogDelta { return { epoch: base.epoch, prevRevision: revision - 1, revision, changes, health: base.health }; }

test('Given colliding snapshots, when one peer goes offline, then host-qualified rows stay isolated and stale', () => {
  const catalog = new FleetCatalogAggregator(() => undefined);
  catalog.connected(A, 1, 'epoch-1'); catalog.connected(B, 1, 'epoch-1');
  assert.deepEqual(catalog.admitWrite(A), { ok: false, error: 'HOST_SYNCING' });
  catalog.snapshot(A, 1, 'epoch-1', snapshot(A)); catalog.snapshot(B, 1, 'epoch-1', snapshot(B)); catalog.offline(A);
  assert.equal(catalog.rows().projects.length, 2);
  assert.equal(new Set(catalog.rows().projects.map((row) => row.key)).size, 2);
  assert.equal(catalog.host(A)?.stale, true); assert.equal(catalog.host(B)?.stale, false);
  assert.deepEqual(catalog.admitWrite(A), { ok: false, error: 'HOST_OFFLINE' });
  assert.deepEqual(catalog.admitWrite(B), { ok: true });
});

test('Given ordered deltas, when duplicates conflict, then only the identical duplicate is idempotent', () => {
  const requested: string[] = []; const catalog = new FleetCatalogAggregator((hostId) => requested.push(hostId));
  const initial = snapshot(); catalog.connected(A, 4, initial.epoch); catalog.snapshot(A, 4, initial.epoch, initial);
  const next = delta(initial, 2, [{ op: 'upsert', entity: 'processing', row: { localId: 'session', provider: 'codex', startedAtMs: 20, lastSeq: 3 } }]);
  assert.equal(catalog.delta(A, 4, initial.epoch, next).kind, 'applied');
  assert.equal(catalog.delta(A, 4, initial.epoch, next).kind, 'idempotent');
  const conflict = { ...next, changes: [{ op: 'upsert', entity: 'processing', row: { localId: 'session', provider: 'codex', startedAtMs: 20, lastSeq: 99 } }] } satisfies FleetCatalogDelta;
  assert.equal(catalog.delta(A, 4, initial.epoch, conflict).kind, 'resync_required');
  assert.deepEqual(catalog.admitWrite(A), { ok: false, error: 'HOST_SYNCING' }); assert.deepEqual(requested, [A]);
});

test('Given current material, when gap, malformed, epoch, or stale-generation input arrives, then it never merges', () => {
  for (const cause of ['gap', 'malformed', 'epoch', 'generation'] as const) {
    const requested: string[] = []; const catalog = new FleetCatalogAggregator((hostId) => requested.push(hostId));
    const initial = snapshot(); catalog.connected(A, 7, initial.epoch); catalog.snapshot(A, 7, initial.epoch, initial);
    const valid = delta(initial, 3, []);
    const body: unknown = cause === 'malformed' ? { ...valid, changes: [{ op: 'upsert', entity: 'pane', row: { localId: 'broken' } }] } : valid;
    const result = catalog.delta(A, cause === 'generation' ? 6 : 7, cause === 'epoch' ? 'epoch-2' : initial.epoch, body);
    assert.equal(result.kind, cause === 'generation' ? 'stale' : 'resync_required');
    assert.equal(catalog.host(A)?.revision, 1); assert.equal(requested.length, cause === 'generation' ? 0 : 1);
  }
});

test('Given oversized peer material, when it reaches the hub, then it resyncs without retaining the rows', () => {
  const requested: string[] = [];
  const catalog = new FleetCatalogAggregator((hostId) => requested.push(hostId));
  const initial = snapshot();
  catalog.connected(A, 1, initial.epoch);

  const oversizedSnapshot = {
    ...initial,
    projects: Array.from({ length: MAX_FLEET_CATALOG_ROWS_PER_ENTITY + 1 }, (_, index) => ({
      localId: `project-${index}`,
      path: `/workspace/${index}`,
      displayName: `project-${index}`,
      isStarred: false,
    })),
  };
  assert.equal(catalog.snapshot(A, 1, initial.epoch, oversizedSnapshot).kind, 'resync_required');
  assert.equal(catalog.host(A), undefined);

  assert.equal(catalog.snapshot(A, 1, initial.epoch, initial).kind, 'applied');
  const oversizedDelta = {
    ...delta(initial, 2, []),
    changes: Array.from({ length: MAX_FLEET_CATALOG_DELTA_CHANGES + 1 }, () => ({
      op: 'upsert' as const,
      entity: 'project' as const,
      row: initial.projects[0]!,
    })),
  };
  assert.equal(catalog.delta(A, 1, initial.epoch, oversizedDelta).kind, 'resync_required');
  assert.equal(catalog.host(A)?.snapshot.projects.length, 1);
  assert.deepEqual(requested, [A, A]);
});

test('Given a newer pane, when removal names its stale complete generation, then resync preserves the newer pane', () => {
  const catalog = new FleetCatalogAggregator(() => undefined); const initial = snapshot();
  catalog.connected(A, 1, initial.epoch); catalog.snapshot(A, 1, initial.epoch, initial);
  const oldPane = initial.panes[0]; if (oldPane === undefined) throw new TypeError('pane fixture missing');
  const newer = { ...oldPane, process: { pid: 11, startedAtMs: 200 } };
  catalog.delta(A, 1, initial.epoch, delta(initial, 2, [{ op: 'upsert', entity: 'pane', row: newer }]));
  const stale = { epoch: initial.epoch, prevRevision: 2, revision: 3, changes: [{ op: 'remove', entity: 'pane', row: oldPane }], health: initial.health } satisfies FleetCatalogDelta;
  assert.equal(catalog.delta(A, 1, initial.epoch, stale).kind, 'resync_required');
  assert.deepEqual(catalog.host(A)?.snapshot.panes[0]?.process, { pid: 11, startedAtMs: 200 });
});

test('Given syncing or a changed epoch, when a valid snapshot arrives, then writes resume from its revision', () => {
  const catalog = new FleetCatalogAggregator(() => undefined); const initial = snapshot();
  catalog.connected(A, 2, initial.epoch); catalog.snapshot(A, 2, initial.epoch, initial); catalog.delta(A, 2, initial.epoch, delta(initial, 3, []));
  assert.deepEqual(catalog.admitWrite(A), { ok: false, error: 'HOST_SYNCING' });
  assert.equal(catalog.snapshot(A, 2, initial.epoch, snapshot(A, initial.epoch, 4)).kind, 'applied');
  const healthOnly = { epoch: initial.epoch, prevRevision: 4, revision: 5, changes: [], health: material(A, 'unknown', false).health } satisfies FleetCatalogDelta;
  assert.equal(catalog.delta(A, 2, initial.epoch, healthOnly).kind, 'applied'); assert.equal(catalog.host(A)?.snapshot.health.live.ok, false);
  catalog.connected(A, 3, 'epoch-2');
  assert.equal(catalog.snapshot(A, 3, 'epoch-2', snapshot(A, 'epoch-2', 1)).kind, 'applied');
  assert.equal(catalog.host(A)?.revision, 1); assert.deepEqual(catalog.admitWrite(A), { ok: true });
});

test('Given accepted connections, when material changes, then snapshots precede complete-row deltas', async () => {
  let current = material(); const listeners = new Set<() => void>();
  const publisher = new PeerCatalogPublisher({ epoch: 'peer-epoch', read: async () => current, subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); } });
  const first: Array<Readonly<{ event: string; body: unknown }>> = []; const second: string[] = [];
  const releaseFirst = await publisher.accept((event, body) => first.push({ event, body }));
  current = material(A, 'running'); await publisher.refresh();
  const releaseSecond = await publisher.accept((event) => second.push(event));
  assert.deepEqual(first.map((item) => item.event), ['catalog.snapshot', 'catalog.delta']); assert.deepEqual(second, ['catalog.snapshot']);
  assert.match(JSON.stringify(first[1]?.body), /"entity":"pane"/); assert.doesNotMatch(JSON.stringify(first), /transcript/i);
  releaseFirst(); releaseSecond(); publisher.stop(); assert.equal(listeners.size, 0);
});

test('Given bursty notifications, when a read is in flight, then work coalesces with bounded backpressure', async () => {
  const held = Promise.withResolvers<void>(); let reads = 0; let current = material(); let notify: (() => void) | undefined;
  const publisher = new PeerCatalogPublisher({ epoch: 'peer-epoch', read: async () => { reads += 1; if (reads === 2) await held.promise; return current; }, subscribe: (listener) => { notify = listener; return () => { notify = undefined; }; } });
  const frames: string[] = []; await publisher.accept((event) => frames.push(event));
  current = material(A, 'running'); notify?.(); current = material(A, 'asking_user', false);
  for (let index = 0; index < 100; index += 1) notify?.();
  held.resolve(); await publisher.whenIdle();
  assert.equal(reads, 3); assert.deepEqual(frames, ['catalog.snapshot', 'catalog.delta']); assert.equal(publisher.currentSnapshot()?.health.live.ok, false);
  publisher.stop();
});

test('Given two collision publishers, when out-of-order and reconnect-stale deltas arrive, then only the addressed host resyncs', async () => {
  let materialA = material(A); let materialB = material(B); let heldA: unknown;
  const catalog = new FleetCatalogAggregator(() => undefined);
  catalog.connected(A, 1, 'epoch-a'); catalog.connected(B, 1, 'epoch-b');
  const publisherA = new PeerCatalogPublisher({ epoch: 'epoch-a', read: async () => materialA, subscribe: () => () => undefined });
  const publisherB = new PeerCatalogPublisher({ epoch: 'epoch-b', read: async () => materialB, subscribe: () => () => undefined });
  let holdA = false;
  const releaseA = await publisherA.accept((event, body) => { if (event === 'catalog.snapshot') catalog.snapshot(A, 1, 'epoch-a', body); else if (holdA) heldA = body; });
  const releaseB = await publisherB.accept((event, body) => { if (event === 'catalog.snapshot') catalog.snapshot(B, 1, 'epoch-b', body); else catalog.delta(B, 1, 'epoch-b', body); });
  holdA = true; materialA = material(A, 'running'); materialB = material(B, 'asking_user');
  await Promise.all([publisherA.refresh(), publisherB.refresh()]);
  const valid = heldA; if (typeof valid !== 'object' || valid === null) throw new TypeError('peer A delta missing');
  const gap = { ...Object.fromEntries(Object.entries(valid)), prevRevision: 2, revision: 3 };

  assert.equal(catalog.delta(A, 1, 'epoch-a', gap).kind, 'resync_required');
  assert.equal(catalog.host(B)?.snapshot.panes[0]?.activity, 'asking_user');
  assert.deepEqual(catalog.admitWrite(A), { ok: false, error: 'HOST_SYNCING' });
  assert.equal(catalog.snapshot(A, 1, 'epoch-a', await publisherA.snapshotBody()).kind, 'applied');
  assert.equal(catalog.delta(A, 1, 'epoch-a', valid).kind, 'resync_required');
  assert.equal(catalog.host(B)?.revision, 2);
  releaseA(); releaseB(); publisherA.stop(); publisherB.stop();
});

test('Given publisher material at the current revision, when conflict or gap enters syncing, then semantic resnapshot recovers', async () => {
  const base = material();
  let current = { ...base, projects: [...base.projects, { localId: 'project-2', path: '/other', displayName: 'other', isStarred: false }] }; let emitted: unknown;
  const publisher = new PeerCatalogPublisher({ epoch: 'epoch', read: async () => current, subscribe: () => () => undefined });
  const catalog = new FleetCatalogAggregator(() => undefined); catalog.connected(A, 1, 'epoch');
  const release = await publisher.accept((event, body) => { if (event === 'catalog.snapshot') catalog.snapshot(A, 1, 'epoch', body); else emitted = body; });
  const processing = current.processing[0]; if (processing === undefined) throw new TypeError('processing fixture missing');
  current = { ...current, processing: [{ ...processing, lastSeq: 3 }] };
  await publisher.refresh();
  const revisionTwo = emitted; if (typeof revisionTwo !== 'object' || revisionTwo === null) throw new TypeError('delta missing');
  assert.equal(catalog.delta(A, 1, 'epoch', revisionTwo).kind, 'applied');
  assert.equal(catalog.delta(A, 1, 'epoch', { ...Object.fromEntries(Object.entries(revisionTwo)), changes: [] }).kind, 'resync_required');
  assert.equal(catalog.snapshot(A, 1, 'epoch', await publisher.snapshotBody()).kind, 'applied');
  assert.deepEqual(catalog.admitWrite(A), { ok: true });

  assert.equal(catalog.delta(A, 1, 'epoch', { ...Object.fromEntries(Object.entries(revisionTwo)), prevRevision: 2, revision: 4 }).kind, 'resync_required');
  assert.equal(catalog.snapshot(A, 1, 'epoch', await publisher.snapshotBody()).kind, 'applied');
  const authoritative = await publisher.snapshotBody();
  if (typeof authoritative !== 'object' || authoritative === null || Array.isArray(authoritative)) throw new TypeError('snapshot missing');
  const changedRows = { ...authoritative, projects: [...current.projects].reverse() };
  assert.equal(catalog.snapshot(A, 1, 'epoch', changedRows).kind, 'resync_required');
  assert.equal(catalog.snapshot(A, 1, 'epoch', authoritative).kind, 'applied');
  const alteredRows = { ...authoritative, projects: current.projects.map((row, index) => index === 0 ? { ...row, displayName: 'altered' } : row) };
  assert.equal(catalog.snapshot(A, 1, 'epoch', alteredRows).kind, 'resync_required');
  assert.deepEqual(catalog.admitWrite(A), { ok: false, error: 'HOST_SYNCING' });
  release(); publisher.stop();
});
