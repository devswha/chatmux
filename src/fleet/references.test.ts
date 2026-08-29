import assert from 'node:assert/strict';
import test from 'node:test';

import { paneRef, parseHostId, projectRef, referenceKey, sessionRef, sessionSlotKey } from './references';

const HOST_A = '11111111-1111-4111-8111-111111111111';
const HOST_B = '22222222-2222-4222-8222-222222222222';

test('Given one local id on two hosts, when keys are derived, then they stay distinct', () => {
  // Given / When
  const onA = sessionSlotKey(HOST_A, 'session-42');
  const onB = sessionSlotKey(HOST_B, 'session-42');

  // Then
  assert.notEqual(onA, onB);
  assert.equal(onA, sessionSlotKey(HOST_A, 'session-42'), 'the key is stable for the same host');
});

test('Given an unknown local host, when a key is derived, then it is namespaced away from qualified keys', () => {
  // Given / When
  const pending = sessionSlotKey(null, 'session-42');

  // Then
  assert.notEqual(pending, 'session-42');
  assert.notEqual(pending, sessionSlotKey(HOST_A, 'session-42'));
  assert.equal(pending, sessionSlotKey(null, 'session-42'));
});

test('Given ambiguous field boundaries, when keys are derived, then length prefixes keep them injective', () => {
  // Given
  const left = sessionSlotKey(HOST_A, 'a:b');
  const right = sessionSlotKey(HOST_A, 'a');

  // When / Then
  assert.notEqual(left, right);
  assert.notEqual(
    referenceKey(sessionRef(HOST_A, 'ab')),
    referenceKey(sessionRef(HOST_A, 'a')) + 'b',
    'no delimiter concatenation ambiguity',
  );
});

test('Given every reference kind, when keys are derived, then kinds never collide', () => {
  // Given
  const pane = paneRef({
    hostId: HOST_A,
    localId: 'session-42',
    lane: 'external',
    tmux: { socketPath: '/tmp/a.sock', sessionId: '$1', windowId: '@1', paneId: '%1' },
    process: { pid: 4242, startedAtMs: 1_700_000_000_000 },
  });

  // When
  const keys = [
    referenceKey({ kind: 'host', hostId: HOST_A }),
    referenceKey(sessionRef(HOST_A, 'session-42')),
    referenceKey(projectRef(HOST_A, 'session-42')),
    referenceKey(pane),
  ];

  // Then
  assert.equal(new Set(keys).size, keys.length);
});

test('Given a pane whose generation changed, when keys are derived, then the key changes', () => {
  // Given
  const target = {
    hostId: HOST_A,
    localId: 'session-42',
    lane: 'live',
    tmux: { socketPath: '/tmp/a.sock', sessionId: '$1', windowId: '@1', paneId: '%1' },
  } as const;

  // When
  const first = referenceKey(paneRef({ ...target, process: { pid: 1, startedAtMs: 2 } }));
  const second = referenceKey(paneRef({ ...target, process: { pid: 1, startedAtMs: 3 } }));

  // Then
  assert.notEqual(first, second);
});

test('Given untrusted host id input, when parsed, then only canonical uuids survive', () => {
  // Given / When / Then
  const mixedCase = '0a1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d';
  assert.equal(parseHostId(HOST_A), HOST_A);
  assert.equal(parseHostId(mixedCase), mixedCase);
  assert.equal(parseHostId(mixedCase.toUpperCase()), null, 'canonical lowercase only');
  assert.equal(parseHostId('not-a-uuid'), null);
  assert.equal(parseHostId(''), null);
  assert.equal(parseHostId(undefined), null);
  assert.equal(parseHostId(42), null);
  assert.equal(parseHostId('11111111-1111-1111-8111-111111111111'), null, 'version must be 4');
});
