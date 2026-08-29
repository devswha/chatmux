import assert from 'node:assert/strict';
import test from 'node:test';

import { parseHostFrame } from './hostFrames';
import {
  applyHostFrame,
  EMPTY_FLEET_HOST_CATALOG,
  MAX_HOST_ROWS_PER_ENTITY,
  type FleetHostCatalog,
} from './hostCatalog';
import {
  deltaFrame,
  LOCAL_HOST_ID,
  paneRow,
  PEER_A_HOST_ID,
  PEER_B_HOST_ID,
  peerDescriptor,
  rosterFrame,
  sessionRow,
  snapshotFrame,
} from './hostCatalog.testSupport';

function apply(catalog: FleetHostCatalog, frame: unknown): FleetHostCatalog {
  const parsed = parseHostFrame(frame);
  assert.ok(parsed, 'fixture frame parses');
  return applyHostFrame(catalog, parsed).catalog;
}

function twoPeers(): FleetHostCatalog {
  const roster = apply(EMPTY_FLEET_HOST_CATALOG, rosterFrame([
    peerDescriptor(LOCAL_HOST_ID, 'workstation'),
    peerDescriptor(PEER_A_HOST_ID, 'studio'),
    peerDescriptor(PEER_B_HOST_ID, 'studio'),
  ]));
  const withA = apply(roster, snapshotFrame(PEER_A_HOST_ID, 4, {
    sessions: [sessionRow('gjc-session', 'refactor the parser')],
    panes: [paneRow('/tmp/peer-a.sock', 'omg')],
  }));
  return apply(withA, snapshotFrame(PEER_B_HOST_ID, 9, {
    sessions: [sessionRow('gjc-session', 'refactor the parser')],
    panes: [paneRow('/tmp/peer-b.sock', 'omg')],
  }));
}

test('Given a roster, when it is applied, then the local host id and every descriptor is recorded', () => {
  const catalog = apply(EMPTY_FLEET_HOST_CATALOG, rosterFrame([
    peerDescriptor(LOCAL_HOST_ID, 'workstation'),
    peerDescriptor(PEER_A_HOST_ID, 'studio', 'connecting'),
  ]));

  assert.equal(catalog.localHostId, LOCAL_HOST_ID);
  assert.deepEqual([...catalog.hosts.keys()], [LOCAL_HOST_ID, PEER_A_HOST_ID]);
  assert.equal(catalog.hosts.get(PEER_A_HOST_ID)?.descriptor.state, 'connecting');
  assert.equal(catalog.hosts.get(PEER_A_HOST_ID)?.epoch, null);
});

test('Given a synchronised peer, when a fresh roster arrives, then its rows survive the descriptor refresh', () => {
  const catalog = twoPeers();
  const refreshed = apply(catalog, rosterFrame([
    peerDescriptor(LOCAL_HOST_ID, 'workstation'),
    peerDescriptor(PEER_A_HOST_ID, 'studio', 'degraded'),
    peerDescriptor(PEER_B_HOST_ID, 'studio'),
  ]));

  assert.equal(refreshed.hosts.get(PEER_A_HOST_ID)?.descriptor.state, 'degraded');
  assert.equal(refreshed.hosts.get(PEER_A_HOST_ID)?.rows.sessions.length, 1);
  assert.equal(refreshed.hosts.get(PEER_A_HOST_ID)?.revision, 4);
});

test('Given two peers with identical rows, when one is replaced by a snapshot, then only that host changes', () => {
  const catalog = twoPeers();
  const peerBBefore = catalog.hosts.get(PEER_B_HOST_ID);

  const next = apply(catalog, snapshotFrame(PEER_A_HOST_ID, 5, { sessions: [], panes: [] }));

  assert.equal(next.hosts.get(PEER_A_HOST_ID)?.rows.sessions.length, 0);
  assert.equal(next.hosts.get(PEER_A_HOST_ID)?.rows.panes.length, 0);
  assert.equal(next.hosts.get(PEER_B_HOST_ID), peerBBefore, 'peer B entry is untouched by identity');
  assert.equal(next.hosts.get(PEER_B_HOST_ID)?.rows.sessions.length, 1);
});

test('Given a synchronised peer, when a contiguous delta arrives, then rows are patched at the new revision', () => {
  const catalog = twoPeers();

  const next = apply(catalog, deltaFrame(PEER_A_HOST_ID, { prevRevision: 4, revision: 5 }, [
    { op: 'upsert', entity: 'session', row: sessionRow('second-session', 'write the tests', 1_700_000_100_000) },
    { op: 'remove', entity: 'pane', row: paneRow('/tmp/peer-a.sock', 'omg') },
  ]));

  const entry = next.hosts.get(PEER_A_HOST_ID);
  assert.equal(entry?.revision, 5);
  assert.equal(entry?.sync, 'synced');
  assert.deepEqual(entry?.rows.sessions.map((row) => row.localId), ['gjc-session', 'second-session']);
  assert.equal(entry?.rows.panes.length, 0);
  assert.equal(next.hosts.get(PEER_B_HOST_ID)?.rows.panes.length, 1, 'peer B panes are untouched');
});

test('Given a gap in one peer delta, when it is applied, then only that host enters syncing and asks to resync', () => {
  const catalog = twoPeers();
  const frame = parseHostFrame(deltaFrame(PEER_A_HOST_ID, { prevRevision: 7, revision: 8 }, []));
  assert.ok(frame);

  const outcome = applyHostFrame(catalog, frame);

  assert.equal(outcome.resyncHostId, PEER_A_HOST_ID);
  const entry = outcome.catalog.hosts.get(PEER_A_HOST_ID);
  assert.equal(entry?.sync, 'syncing');
  assert.equal(entry?.rows.sessions.length, 1, 'a gap keeps the last known rows visible');
  assert.equal(entry?.revision, 4, 'a gap never advances the revision');
  assert.equal(outcome.catalog.hosts.get(PEER_B_HOST_ID)?.sync, 'synced');
  assert.equal(outcome.catalog.hosts.get(PEER_B_HOST_ID)?.rows.sessions.length, 1);
});

test('Given a peer epoch change, when a delta arrives under the new epoch, then the host resyncs instead of merging', () => {
  const catalog = twoPeers();
  const frame = parseHostFrame({
    ...deltaFrame(PEER_A_HOST_ID, { prevRevision: 4, revision: 5 }, []),
    epoch: 'epoch-restarted',
  });
  assert.ok(frame);

  const outcome = applyHostFrame(catalog, frame);

  assert.equal(outcome.resyncHostId, PEER_A_HOST_ID);
  assert.equal(outcome.catalog.hosts.get(PEER_A_HOST_ID)?.sync, 'syncing');
  assert.equal(outcome.catalog.hosts.get(PEER_A_HOST_ID)?.epoch, `epoch-${PEER_A_HOST_ID}`);
});

test('Given an applied delta, when the identical delta is replayed, then the catalog is unchanged and no resync is asked', () => {
  const first = twoPeers();
  const change = [{ op: 'upsert', entity: 'session', row: sessionRow('second-session', 'write the tests') }];
  const applied = apply(first, deltaFrame(PEER_A_HOST_ID, { prevRevision: 4, revision: 5 }, change));
  const replay = parseHostFrame(deltaFrame(PEER_A_HOST_ID, { prevRevision: 4, revision: 5 }, change));
  assert.ok(replay);

  const outcome = applyHostFrame(applied, replay);

  assert.equal(outcome.resyncHostId, null);
  assert.equal(outcome.catalog, applied, 'a duplicate delta produces no new state');
});

test('Given a syncing peer, when its snapshot lands, then it is synchronised again at the snapshot revision', () => {
  const catalog = twoPeers();
  const gapped = apply(catalog, deltaFrame(PEER_A_HOST_ID, { prevRevision: 7, revision: 8 }, []));
  assert.equal(gapped.hosts.get(PEER_A_HOST_ID)?.sync, 'syncing');

  const resynced = apply(gapped, snapshotFrame(PEER_A_HOST_ID, 9, {
    sessions: [sessionRow('gjc-session', 'refactor the parser')],
  }));

  assert.equal(resynced.hosts.get(PEER_A_HOST_ID)?.sync, 'synced');
  assert.equal(resynced.hosts.get(PEER_A_HOST_ID)?.revision, 9);
});

test('Given an offline host-state frame, when it is applied, then rows stay visible and the state is explicit', () => {
  const catalog = twoPeers();

  const next = apply(catalog, {
    kind: 'fleet.host_state',
    host: peerDescriptor(PEER_A_HOST_ID, 'studio', 'offline'),
  });

  const entry = next.hosts.get(PEER_A_HOST_ID);
  assert.equal(entry?.descriptor.state, 'offline');
  assert.equal(entry?.rows.sessions.length, 1, 'the last snapshot stays visible while the host is offline');
  assert.equal(next.hosts.get(PEER_B_HOST_ID)?.descriptor.state, 'online');
});

test('Given a host outside the roster, when a snapshot or state frame arrives, then it is ignored', () => {
  const catalog = twoPeers();
  const unknownHostId = '44444444-4444-4444-8444-444444444444';

  const withSnapshot = apply(catalog, snapshotFrame(unknownHostId, 1, {
    sessions: [sessionRow('gjc-session', 'ghost')],
  }));
  const withState = apply(withSnapshot, {
    kind: 'fleet.host_state',
    host: peerDescriptor(unknownHostId, 'ghost', 'online'),
  });

  assert.equal(withState.hosts.has(unknownHostId), false);
  assert.equal(withState.hosts.size, 3);
});

test('Given a host removed from the roster, when the roster is applied, then only that host disappears', () => {
  const catalog = twoPeers();

  const next = apply(catalog, rosterFrame([
    peerDescriptor(LOCAL_HOST_ID, 'workstation'),
    peerDescriptor(PEER_B_HOST_ID, 'studio'),
  ]));

  assert.equal(next.hosts.has(PEER_A_HOST_ID), false);
  assert.equal(next.hosts.get(PEER_B_HOST_ID)?.rows.sessions.length, 1);
});

test('Given a peer flooding rows, when its snapshot exceeds the row cap, then only that host is truncated', () => {
  const catalog = twoPeers();
  const flood = Array.from(
    { length: MAX_HOST_ROWS_PER_ENTITY + 25 },
    (_unused, index) => sessionRow(`session-${index}`, `session ${index}`),
  );

  const next = apply(catalog, snapshotFrame(PEER_A_HOST_ID, 6, { sessions: flood }));

  const entry = next.hosts.get(PEER_A_HOST_ID);
  assert.equal(entry?.rows.sessions.length, MAX_HOST_ROWS_PER_ENTITY);
  assert.equal(entry?.truncated, true);
  assert.equal(next.hosts.get(PEER_B_HOST_ID)?.truncated, false, 'backpressure is per host');
  assert.equal(next.hosts.get(PEER_B_HOST_ID)?.rows.sessions.length, 1);
});
