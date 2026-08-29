import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseHostFrame,
  parseHostRoster,
} from './hostFrames';
import {
  deltaFrame,
  LOCAL_HOST_ID,
  paneRow,
  PEER_A_HOST_ID,
  peerDescriptor,
  rosterFrame,
  sessionRow,
  snapshotFrame,
} from './hostCatalog.testSupport';
import { paneRowKey, parseHostPaneRow } from './hostRows';

test('Given a roster frame, when it is parsed, then the local host id and descriptors are typed', () => {
  const frame = parseHostFrame(rosterFrame([
    peerDescriptor(LOCAL_HOST_ID, 'workstation'),
    peerDescriptor(PEER_A_HOST_ID, 'studio', 'degraded'),
  ]));

  assert.equal(frame?.kind, 'roster');
  assert.equal(frame?.kind === 'roster' ? frame.localHostId : null, LOCAL_HOST_ID);
  assert.equal(frame?.kind === 'roster' ? frame.hosts[1]?.state : null, 'degraded');
});

test('Given a REST roster envelope, when it is parsed, then both the wrapped and bare shapes are accepted', () => {
  const bare = { localHostId: LOCAL_HOST_ID, hosts: [peerDescriptor(PEER_A_HOST_ID, 'studio')] };

  assert.equal(parseHostRoster(bare)?.hosts.length, 1);
  assert.equal(parseHostRoster({ success: true, data: bare })?.hosts.length, 1);
  assert.equal(parseHostRoster({ success: true, data: bare })?.localHostId, LOCAL_HOST_ID);
});

test('Given a roster with an unusable descriptor, when it is parsed, then the whole frame is rejected', () => {
  const malformedState = { ...peerDescriptor(PEER_A_HOST_ID, 'studio'), state: 'sleeping' };
  const malformedHostId = { ...peerDescriptor(PEER_A_HOST_ID, 'studio'), hostId: 'peer-a' };
  const emptyLabel = { ...peerDescriptor(PEER_A_HOST_ID, 'studio'), displayLabel: '' };

  for (const descriptor of [malformedState, malformedHostId, emptyLabel]) {
    assert.equal(parseHostFrame(rosterFrame([descriptor as never])), null);
  }
  assert.equal(
    parseHostRoster({ localHostId: LOCAL_HOST_ID, hosts: [
      peerDescriptor(PEER_A_HOST_ID, 'studio'),
      peerDescriptor(PEER_A_HOST_ID, 'studio-again'),
    ] }),
    null,
    'a duplicated host id is not a roster',
  );
});

test('Given an unknown frame kind, when it is parsed, then nothing is produced', () => {
  for (const frame of [
    { kind: 'fleet.unknown' },
    { kind: 'session_upserted', sessionId: 'gjc-session' },
    null,
    'fleet.hosts',
    [rosterFrame([])],
  ]) {
    assert.equal(parseHostFrame(frame), null);
  }
});

test('Given a snapshot frame, when it is parsed, then every row is typed and pane identity survives', () => {
  const frame = parseHostFrame(snapshotFrame(PEER_A_HOST_ID, 7, {
    sessions: [sessionRow('gjc-session', 'refactor')],
    panes: [paneRow('/tmp/peer-a.sock', 'omg')],
  }));

  assert.equal(frame?.kind, 'snapshot');
  if (frame?.kind !== 'snapshot') return;
  assert.equal(frame.revision, 7);
  assert.equal(frame.rows.panes[0]?.tmux.socketPath, '/tmp/peer-a.sock');
  assert.equal(frame.rows.sessions[0]?.summary, 'refactor');
  assert.equal(frame.rows.projects[0]?.displayName, 'omg');
});

test('Given a snapshot with an unusable field, when it is parsed, then the frame is dropped whole', () => {
  const base = snapshotFrame(PEER_A_HOST_ID, 7, { panes: [paneRow('/tmp/peer-a.sock', 'omg')] });

  assert.equal(parseHostFrame({ ...base, hostId: 'peer-a' }), null, 'a non-canonical host id');
  assert.equal(parseHostFrame({ ...base, revision: 1.5 }), null, 'a fractional revision');
  assert.equal(parseHostFrame({ ...base, revision: -1 }), null, 'a negative revision');
  assert.equal(parseHostFrame({ ...base, epoch: '' }), null, 'an empty epoch');
  assert.equal(parseHostFrame({ ...base, epoch: 'e'.repeat(257) }), null, 'an oversized epoch');
  assert.equal(parseHostFrame({ ...base, sessions: {} }), null, 'a non-array session list');
  assert.equal(
    parseHostFrame({ ...base, panes: [{ ...paneRow('/tmp/peer-a.sock', 'omg'), lane: 'shell' }] }),
    null,
    'an unknown lane',
  );
  assert.equal(
    parseHostFrame({ ...base, panes: [{ ...paneRow('/tmp/peer-a.sock', 'omg'), tmux: { paneId: '%1' } }] }),
    null,
    'a partial pane identity',
  );
});

test('Given a pane row without a live process, when it is parsed, then it stays a row with no generation', () => {
  const row = parseHostPaneRow({ ...paneRow('/tmp/peer-a.sock', 'omg'), process: null });

  assert.equal(row?.process, null);
  assert.equal(row?.tmuxName, 'omg');
});

test('Given identical pane rows on two hosts, when keys are built, then they never collide', () => {
  const row = paneRow('/tmp/same.sock', 'omg');

  assert.notEqual(paneRowKey(LOCAL_HOST_ID, row), paneRowKey(PEER_A_HOST_ID, row));
});

test('Given a delta frame, when it is parsed, then upserts and removals keep their entity', () => {
  const frame = parseHostFrame(deltaFrame(PEER_A_HOST_ID, { prevRevision: 4, revision: 5 }, [
    { op: 'upsert', entity: 'session', row: sessionRow('gjc-session', 'refactor') },
    { op: 'remove', entity: 'session', row: sessionRow('gone', 'gone') },
    { op: 'remove', entity: 'pane', row: paneRow('/tmp/peer-a.sock', 'omg') },
  ]));

  assert.equal(frame?.kind, 'delta');
  if (frame?.kind !== 'delta') return;
  assert.deepEqual(frame.changes.map((change) => `${change.op}:${change.entity}`), [
    'upsert:session',
    'remove:session',
    'remove:pane',
  ]);
});

test('Given a delta with an unusable change, when it is parsed, then no change is applied', () => {
  const unusable = [
    [{ op: 'patch', entity: 'session', row: sessionRow('gjc-session', 'refactor') }],
    [{ op: 'upsert', entity: 'host', row: sessionRow('gjc-session', 'refactor') }],
    [{ op: 'upsert', entity: 'session', row: { summary: 'no local id' } }],
    'not-an-array',
  ];

  for (const changes of unusable) {
    assert.equal(parseHostFrame(deltaFrame(PEER_A_HOST_ID, { prevRevision: 4, revision: 5 }, changes as never)), null);
  }
});

test('Given a host-state frame, when it is parsed, then the descriptor carries the explicit peer state', () => {
  for (const state of ['connecting', 'syncing', 'online', 'degraded', 'offline', 'revoked', 'incompatible'] as const) {
    const frame = parseHostFrame({
      kind: 'fleet.host_state',
      host: peerDescriptor(PEER_A_HOST_ID, 'studio', state),
    });
    assert.equal(frame?.kind === 'host-state' ? frame.host.state : null, state);
  }
  assert.equal(parseHostFrame({ kind: 'fleet.host_state', host: { hostId: PEER_A_HOST_ID } }), null);
});
