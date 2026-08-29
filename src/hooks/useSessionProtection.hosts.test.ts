import assert from 'node:assert/strict';
import test from 'node:test';

import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';

import { scopeSessionActivity } from '../fleet/hostScopedSessionActivity';
import { sessionSlotKey } from '../fleet/references';

import { useSessionProtection } from './useSessionProtection';

const HOST_A = '11111111-1111-4111-8111-111111111111';
const HOST_B = '22222222-2222-4222-8222-222222222222';

type Protection = ReturnType<typeof useSessionProtection>;

function mountProtection(): { current: () => Protection; unmount: () => void } {
  let latest: Protection | undefined;
  function Harness() {
    latest = useSessionProtection();
    return null;
  }
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  act(() => {
    renderer = TestRenderer.create(createElement(Harness));
  });
  return {
    current: () => {
      assert.ok(latest);
      return latest;
    },
    unmount: () => act(() => renderer?.unmount()),
  };
}

test('Given one local id processing on two hosts, when synced, then each host keeps its own activity', (t) => {
  // Given
  const protection = mountProtection();
  t.after(protection.unmount);

  // When
  act(() => {
    protection.current().syncProcessing([
      { hostId: HOST_A, localId: 'session-42', statusText: 'thinking on a', startedAt: 10 },
      { hostId: HOST_B, localId: 'session-42', statusText: 'thinking on b', startedAt: 20 },
    ]);
  });

  // Then
  const activities = protection.current().processingSessions;
  assert.equal(activities.size, 2);
  assert.equal(activities.get(sessionSlotKey(HOST_A, 'session-42'))?.statusText, 'thinking on a');
  assert.equal(activities.get(sessionSlotKey(HOST_B, 'session-42'))?.statusText, 'thinking on b');
});

test('Given activity on two hosts, when scoped to one host, then only that host is visible by bare id', (t) => {
  // Given
  const protection = mountProtection();
  t.after(protection.unmount);
  act(() => {
    protection.current().syncProcessing([
      { hostId: HOST_A, localId: 'session-42', statusText: 'on a', startedAt: 10 },
      { hostId: HOST_B, localId: 'session-42', statusText: 'on b', startedAt: 20 },
      { hostId: null, localId: 'legacy-session', statusText: 'pre-identity', startedAt: 30 },
    ]);
  });

  // When
  const scopedToB = scopeSessionActivity(protection.current().processingSessions, HOST_B);
  const scopedToUnknown = scopeSessionActivity(protection.current().processingSessions, null);

  // Then
  assert.equal(scopedToB.size, 1);
  assert.equal(scopedToB.get('session-42')?.statusText, 'on b');
  assert.equal(scopedToUnknown.get('legacy-session')?.statusText, 'pre-identity');
  assert.equal(scopedToUnknown.get('session-42'), undefined, 'qualified rows never leak into the unknown-host view');
});

test('Given a processing session on one host, when the twin on another host goes idle, then the first survives', (t) => {
  // Given
  const protection = mountProtection();
  t.after(protection.unmount);
  act(() => {
    protection.current().markProcessing({ hostId: HOST_A, localId: 'session-42' }, { statusText: 'running' });
    protection.current().markProcessing({ hostId: HOST_B, localId: 'session-42' }, { statusText: 'running' });
  });

  // When
  act(() => {
    protection.current().markIdle({ hostId: HOST_B, localId: 'session-42' });
  });

  // Then
  assert.equal(protection.current().processingSessions.size, 1);
  assert.ok(protection.current().processingSessions.has(sessionSlotKey(HOST_A, 'session-42')));
});

test('Given a stale idle ack, when it names an older request, then the newer request keeps processing', (t) => {
  // Given
  const protection = mountProtection();
  t.after(protection.unmount);
  act(() => {
    protection.current().markProcessing({ hostId: HOST_A, localId: 'session-42' });
  });
  const startedAt = protection.current().processingSessions.get(sessionSlotKey(HOST_A, 'session-42'))?.startedAt;
  assert.ok(typeof startedAt === 'number');

  // When
  act(() => {
    protection.current().markIdle({ hostId: HOST_A, localId: 'session-42' }, { ifStartedBefore: startedAt });
  });

  // Then
  assert.equal(protection.current().processingSessions.size, 1, 'an ack older than the run must not clear it');
});

test('Given a sync that omits one host, when applied, then only the omitted host loses its stale row', (t) => {
  // Given
  const protection = mountProtection();
  t.after(protection.unmount);
  act(() => {
    protection.current().syncProcessing([
      { hostId: HOST_A, localId: 'session-42', startedAt: 1 },
      { hostId: HOST_B, localId: 'session-42', startedAt: 1 },
    ]);
  });

  // When
  act(() => {
    protection.current().syncProcessing([{ hostId: HOST_A, localId: 'session-42', startedAt: 1 }]);
  });

  // Then
  assert.deepEqual(
    [...protection.current().processingSessions.keys()],
    [sessionSlotKey(HOST_A, 'session-42')],
  );
});
