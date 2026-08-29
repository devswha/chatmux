import assert from 'node:assert/strict';
import test from 'node:test';

import { applyHostFrame, EMPTY_FLEET_HOST_CATALOG, type FleetHostCatalog } from './hostCatalog';
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
import { parseHostFrame } from './hostFrames';
import { hostActionsEnabled, hostAvailability, hostGroups, type HostGroup } from './hostGroups';

const LOCAL = {
  label: 'This machine',
  rowLabels: ['omg'],
  counts: { projects: 1, sessions: 2, panes: 1 },
} as const;

function apply(catalog: FleetHostCatalog, frame: unknown): FleetHostCatalog {
  const parsed = parseHostFrame(frame);
  assert.ok(parsed, 'fixture frame parses');
  return applyHostFrame(catalog, parsed).catalog;
}

/** Local host plus two peers that collide on label, session id and pane name. */
function collisionCatalog(
  peerAState: Parameters<typeof peerDescriptor>[2] = 'online',
  peerBState: Parameters<typeof peerDescriptor>[2] = 'online',
): FleetHostCatalog {
  const roster = apply(EMPTY_FLEET_HOST_CATALOG, rosterFrame([
    peerDescriptor(LOCAL_HOST_ID, 'workstation'),
    peerDescriptor(PEER_A_HOST_ID, 'studio', peerAState),
    peerDescriptor(PEER_B_HOST_ID, 'studio', peerBState),
  ]));
  const withA = apply(roster, snapshotFrame(PEER_A_HOST_ID, 1, {
    sessions: [sessionRow('gjc-session', 'refactor the parser')],
    panes: [paneRow('/tmp/peer-a.sock', 'omg')],
  }));
  return apply(withA, snapshotFrame(PEER_B_HOST_ID, 1, {
    sessions: [sessionRow('gjc-session', 'refactor the parser')],
    panes: [paneRow('/tmp/peer-b.sock', 'omg')],
  }));
}

function group(groups: readonly HostGroup[], hostId: string): HostGroup {
  const found = groups.find((candidate) => candidate.hostId === hostId);
  assert.ok(found, `group for ${hostId} is present`);
  return found;
}

test('Given no remote host, when groups are built, then there is no host chrome at all', () => {
  const localOnly = apply(EMPTY_FLEET_HOST_CATALOG, rosterFrame([
    peerDescriptor(LOCAL_HOST_ID, 'workstation'),
  ]));

  assert.deepEqual(hostGroups({ catalog: localOnly, local: LOCAL, filter: null }), []);
  assert.deepEqual(
    hostGroups({ catalog: EMPTY_FLEET_HOST_CATALOG, local: LOCAL, filter: null }),
    [],
  );
});

test('Given three hosts, when groups are built, then the local host is first and peers follow deterministically', () => {
  const groups = hostGroups({ catalog: collisionCatalog(), local: LOCAL, filter: null });

  assert.deepEqual(groups.map((entry) => entry.hostId), [LOCAL_HOST_ID, PEER_A_HOST_ID, PEER_B_HOST_ID]);
  assert.equal(groups[0]?.isLocal, true);
  assert.equal(groups[0]?.rows.length, 0, 'the local group defers to the existing local sections');
  assert.deepEqual(groups[0]?.counts, LOCAL.counts);
  assert.equal(groups[1]?.isLocal, false);
});

test('Given peers sharing a label, when groups are built, then colliding rows are marked as duplicated', () => {
  const groups = hostGroups({ catalog: collisionCatalog(), local: LOCAL, filter: null });

  const peerA = group(groups, PEER_A_HOST_ID);
  const paneRowA = peerA.rows.find((row) => row.kind === 'pane');
  assert.equal(paneRowA?.label, 'omg');
  assert.equal(paneRowA?.duplicateLabel, true, 'the same pane name exists on the local host and peer B');
  assert.equal(peerA.label, 'studio');
  assert.equal(peerA.labelDuplicated, true, 'two peers share the display label');
  assert.notEqual(
    paneRowA?.key,
    group(groups, PEER_B_HOST_ID).rows.find((row) => row.kind === 'pane')?.key,
    'identical labels on two hosts never collapse into one key',
  );
});

test('Given a peer whose pane owns a session, when groups are built, then the session is not listed twice', () => {
  const groups = hostGroups({ catalog: collisionCatalog(), local: LOCAL, filter: null });

  const peerA = group(groups, PEER_A_HOST_ID);
  assert.deepEqual(peerA.rows.map((row) => row.kind), ['pane']);
  assert.deepEqual(peerA.counts, { projects: 1, sessions: 1, panes: 1 });
});

test('Given a host filter, when groups are built, then only the selected host is shown', () => {
  const catalog = collisionCatalog();

  const filtered = hostGroups({ catalog, local: LOCAL, filter: PEER_B_HOST_ID });
  const unknown = hostGroups({ catalog, local: LOCAL, filter: 'not-a-host' });

  assert.deepEqual(filtered.map((entry) => entry.hostId), [PEER_B_HOST_ID]);
  assert.deepEqual(
    unknown.map((entry) => entry.hostId),
    [LOCAL_HOST_ID, PEER_A_HOST_ID, PEER_B_HOST_ID],
    'a filter naming no known host falls back to showing every host',
  );
});

test('Given every peer state, when availability is derived, then only a synchronised online host is actionable', () => {
  assert.equal(hostActionsEnabled('online', 'synced'), true);
  assert.equal(hostActionsEnabled('online', 'syncing'), false);
  for (const state of ['connecting', 'syncing', 'degraded', 'offline', 'revoked', 'incompatible'] as const) {
    assert.equal(hostActionsEnabled(state, 'synced'), false, `${state} must not be actionable`);
  }
  assert.equal(hostAvailability('online', 'synced'), 'available');
  assert.equal(hostAvailability('degraded', 'synced'), 'unavailable');
  assert.equal(hostAvailability('online', 'syncing'), 'unavailable');
});

test('Given an offline peer, when groups are built, then its rows stay visible, stale and unactionable', () => {
  const groups = hostGroups({ catalog: collisionCatalog('offline'), local: LOCAL, filter: null });

  const peerA = group(groups, PEER_A_HOST_ID);
  assert.equal(peerA.state, 'offline');
  assert.equal(peerA.actionsEnabled, false);
  assert.equal(peerA.availability, 'unavailable');
  assert.equal(peerA.rows.length, 1, 'the last known rows remain visible');
  assert.equal(peerA.rows[0]?.stale, true);
  assert.equal(group(groups, PEER_B_HOST_ID).actionsEnabled, true, 'the healthy peer stays actionable');
});

test('Given a peer with no rows, when groups are built, then empty is distinguished from unavailable', () => {
  const emptyOnline = apply(collisionCatalog(), snapshotFrame(PEER_A_HOST_ID, 2, { sessions: [], panes: [] }));

  const groups = hostGroups({ catalog: emptyOnline, local: LOCAL, filter: null });
  const peerA = group(groups, PEER_A_HOST_ID);

  assert.equal(peerA.rows.length, 0);
  assert.equal(peerA.availability, 'available');
  assert.equal(peerA.emptiness, 'empty');
  assert.equal(group(groups, PEER_B_HOST_ID).emptiness, 'populated');
});

test('Given a peer that never sent a snapshot, when groups are built, then it reads as unavailable, not empty', () => {
  const roster = apply(EMPTY_FLEET_HOST_CATALOG, rosterFrame([
    peerDescriptor(LOCAL_HOST_ID, 'workstation'),
    peerDescriptor(PEER_A_HOST_ID, 'studio', 'connecting'),
  ]));

  const peerA = group(hostGroups({ catalog: roster, local: LOCAL, filter: null }), PEER_A_HOST_ID);

  assert.equal(peerA.availability, 'unavailable');
  assert.equal(peerA.emptiness, 'unknown');
  assert.equal(peerA.actionsEnabled, false);
});

test('Given one peer gapping, when groups are rebuilt, then the other peer group is identical', () => {
  const catalog = collisionCatalog();
  const before = hostGroups({ catalog, local: LOCAL, filter: null });

  const gapped = apply(catalog, deltaFrame(PEER_A_HOST_ID, { prevRevision: 9, revision: 10 }, []));
  const after = hostGroups({ catalog: gapped, local: LOCAL, filter: null });

  assert.equal(group(after, PEER_A_HOST_ID).sync, 'syncing');
  assert.equal(group(after, PEER_A_HOST_ID).actionsEnabled, false);
  assert.deepEqual(group(after, PEER_B_HOST_ID), group(before, PEER_B_HOST_ID));
  assert.deepEqual(group(after, LOCAL_HOST_ID), group(before, LOCAL_HOST_ID));
});

test('Given a truncated peer, when groups are built, then only that group reports backpressure', () => {
  const flooded = apply(collisionCatalog(), snapshotFrame(PEER_A_HOST_ID, 3, {
    sessions: Array.from({ length: 600 }, (_unused, index) => sessionRow(`session-${index}`, `s${index}`)),
  }));

  const groups = hostGroups({ catalog: flooded, local: LOCAL, filter: null });

  assert.equal(group(groups, PEER_A_HOST_ID).truncated, true);
  assert.equal(group(groups, PEER_B_HOST_ID).truncated, false);
});

test('Given remote sessions, when rows are built, then they are ordered by most recent activity', () => {
  const catalog = apply(collisionCatalog(), snapshotFrame(PEER_A_HOST_ID, 4, {
    sessions: [
      sessionRow('older', 'older work', 1_700_000_000_000),
      sessionRow('newest', 'newest work', 1_700_000_900_000),
    ],
  }));

  const rows = group(hostGroups({ catalog, local: LOCAL, filter: null }), PEER_A_HOST_ID).rows;

  assert.deepEqual(rows.map((row) => row.localId), ['newest', 'older']);
  assert.deepEqual(rows.map((row) => row.detail), ['omg', 'omg'], 'each session row names its project');
});
