import assert from 'node:assert/strict';
import test from 'node:test';

import type { FleetHostSessionRow } from '../../../fleet/discovery/hostRows';

import { buildPaletteSessionRows } from './paletteSessionRows';
import type { SessionMessageMatch } from './useSessionMessageSearch';
import type { SessionResult } from './useSessionsSource';

const LOCAL = '11111111-1111-4111-8111-111111111111';
const PEER_A = '22222222-2222-4222-8222-222222222222';
const PEER_B = '33333333-3333-4333-8333-333333333333';
const SESSION = 'session-collision';

const peerRow = (localId: string, summary: string): FleetHostSessionRow => ({
  localId,
  projectLocalId: 'project-collision',
  provider: 'gjc',
  summary,
  lastActivityMs: 1,
});
const match = (snippet: string): SessionMessageMatch => ({
  sessionId: SESSION,
  label: 'searched',
  snippet,
  provider: 'gjc' as SessionMessageMatch['provider'],
});
const localSession: SessionResult = { id: SESSION, label: 'hub session' };

test('Given a local project, when palette rows are built, then the legacy local deep link is kept', () => {
  // Given / When
  const rows = buildPaletteSessionRows({
    hostId: LOCAL, localHostId: LOCAL, localSessions: [localSession], peerSessions: [], matches: [],
  });

  // Then
  assert.deepEqual(rows.map((row) => row.route), [`/session/${SESSION}`]);
  assert.deepEqual(rows.map((row) => row.label), ['hub session']);
});

test('Given a project with no known host yet, when palette rows are built, then the legacy link is still used', () => {
  // Given / When
  const rows = buildPaletteSessionRows({
    hostId: null, localHostId: null, localSessions: [localSession], peerSessions: [], matches: [],
  });

  // Then
  assert.deepEqual(rows.map((row) => row.route), [`/session/${SESSION}`]);
});

test('Given the same session id on two peers, when palette rows are built, then each row routes to its own host', () => {
  // Given
  const shared = { localHostId: LOCAL, localSessions: [] as readonly SessionResult[], matches: [match('from A')] };

  // When
  const fromA = buildPaletteSessionRows({ ...shared, hostId: PEER_A, peerSessions: [peerRow(SESSION, 'peer A')] });
  const fromB = buildPaletteSessionRows({ ...shared, hostId: PEER_B, peerSessions: [peerRow(SESSION, 'peer B')] });

  // Then
  assert.deepEqual(fromA.map((row) => row.route), [`/hosts/${PEER_A}/session/${SESSION}`]);
  assert.deepEqual(fromB.map((row) => row.route), [`/hosts/${PEER_B}/session/${SESSION}`]);
  assert.notEqual(fromA[0]?.route, fromB[0]?.route);
});

test('Given a peer project, when palette rows are built, then the roster comes from the peer catalog and never the hub route', () => {
  // Given
  const hubRoster: readonly SessionResult[] = [{ id: 'hub-only', label: 'hub session' }];

  // When
  const rows = buildPaletteSessionRows({
    hostId: PEER_A,
    localHostId: LOCAL,
    localSessions: hubRoster,
    peerSessions: [peerRow(SESSION, 'peer A session')],
    matches: [],
  });

  // Then
  assert.deepEqual(rows.map((row) => row.id), [SESSION]);
  assert.deepEqual(rows.map((row) => row.label), ['peer A session']);
});

test('Given a search match for a rostered session, when palette rows are built, then one row carries the snippet', () => {
  // Given / When
  const rows = buildPaletteSessionRows({
    hostId: PEER_A,
    localHostId: LOCAL,
    localSessions: [],
    peerSessions: [peerRow(SESSION, 'peer A session')],
    matches: [match('matched text')],
  });

  // Then
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.snippet, 'matched text');
  assert.equal(rows[0]?.label, 'peer A session');
});

test('Given a search match outside the roster, when palette rows are built, then it becomes its own host-qualified row', () => {
  // Given / When
  const rows = buildPaletteSessionRows({
    hostId: PEER_A, localHostId: LOCAL, localSessions: [], peerSessions: [], matches: [match('only match')],
  });

  // Then
  assert.deepEqual(rows.map((row) => [row.label, row.snippet, row.route]), [
    ['searched', 'only match', `/hosts/${PEER_A}/session/${SESSION}`],
  ]);
});
