import assert from 'node:assert/strict';
import test from 'node:test';

import { sessionRef } from './references';
import { resolveSessionRoute, sessionRoutePath } from './sessionRoute';

const HOST_A = '11111111-1111-4111-8111-111111111111';
const HOST_B = '22222222-2222-4222-8222-222222222222';

test('Given a legacy link and a known local host, when resolved, then it stays local', () => {
  // Given / When
  const resolved = resolveSessionRoute({ sessionId: 'session-42' }, HOST_A);

  // Then
  assert.deepEqual(resolved, {
    kind: 'local-session',
    reference: { kind: 'session', hostId: HOST_A, localId: 'session-42' },
  });
});

test('Given a legacy link before identity arrives, when resolved, then it stays local with an unknown host', () => {
  // Given / When
  const resolved = resolveSessionRoute({ sessionId: 'session-42' }, null);

  // Then
  assert.deepEqual(resolved, { kind: 'local-session', reference: null, localId: 'session-42' });
});

test('Given a host link for another host, when resolved, then it is remote', () => {
  // Given / When
  const resolved = resolveSessionRoute({ hostId: HOST_B, sessionId: 'session-42' }, HOST_A);

  // Then
  assert.deepEqual(resolved, {
    kind: 'remote-session',
    reference: { kind: 'session', hostId: HOST_B, localId: 'session-42' },
  });
});

test('Given a host link for the local host, when resolved, then it is local', () => {
  // Given / When
  const resolved = resolveSessionRoute({ hostId: HOST_A, sessionId: 'session-42' }, HOST_A);

  // Then
  assert.deepEqual(resolved, {
    kind: 'local-session',
    reference: { kind: 'session', hostId: HOST_A, localId: 'session-42' },
  });
});

test('Given a malformed host segment, when resolved, then the route fails closed with no local fallback', () => {
  // Given / When
  const resolved = resolveSessionRoute({ hostId: 'not-a-host', sessionId: 'session-42' }, HOST_A);

  // Then
  assert.deepEqual(resolved, { kind: 'host-not-found', requestedHostId: 'not-a-host' });
});

test('Given a host link without a session, when resolved, then the route still fails closed', () => {
  // Given / When
  const malformed = resolveSessionRoute({ hostId: 'not-a-host' }, HOST_A);
  const empty = resolveSessionRoute({}, HOST_A);

  // Then
  assert.deepEqual(malformed, { kind: 'host-not-found', requestedHostId: 'not-a-host' });
  assert.deepEqual(empty, { kind: 'no-session' });
});

test('Given a session reference, when a path is built, then local keeps the legacy url and remote is qualified', () => {
  // Given / When / Then
  assert.equal(sessionRoutePath(sessionRef(HOST_A, 'session-42'), HOST_A), '/session/session-42');
  assert.equal(
    sessionRoutePath(sessionRef(HOST_B, 'session-42'), HOST_A),
    `/hosts/${HOST_B}/session/session-42`,
  );
  assert.equal(
    sessionRoutePath(sessionRef(HOST_B, 'a b/c'), HOST_A),
    `/hosts/${HOST_B}/session/a%20b%2Fc`,
    'path segments are encoded',
  );
});

test('Given an unknown local host, when a path is built, then a host link is emitted instead of guessing local', () => {
  // Given / When / Then
  assert.equal(
    sessionRoutePath(sessionRef(HOST_A, 'session-42'), null),
    `/hosts/${HOST_A}/session/session-42`,
  );
});
