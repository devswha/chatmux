import assert from 'node:assert/strict';
import test from 'node:test';

import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';

import { sessionSlotKey } from '../fleet/references';

import { type SessionStoreScope } from './sessionStoreScope';
import { type SessionStore, useSessionStore } from './useSessionStore';

const HOST_A = '11111111-1111-4111-8111-111111111111';
const HOST_B = '22222222-2222-4222-8222-222222222222';
const SESSION = 'session-collision';

const message = (id: string) => ({
  id,
  sessionId: SESSION,
  timestamp: '2026-01-01T00:00:00Z',
  kind: 'text' as const,
  provider: 'claude' as const,
});

type Harness = {
  readonly store: () => SessionStore;
  readonly renders: () => number;
  readonly rescope: (scope: SessionStoreScope) => void;
  readonly dispose: () => void;
};

/**
 * One store instance whose scope changes without a remount — the case a
 * host switch must survive on its own, independent of any parent key.
 */
function mount(initial: SessionStoreScope): Harness {
  let latest: SessionStore | undefined;
  let renders = 0;
  function Harness({ scope }: { scope: SessionStoreScope }) {
    renders += 1;
    latest = useSessionStore(scope);
    return null;
  }
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  act(() => {
    renderer = TestRenderer.create(createElement(Harness, { scope: initial }));
  });
  const active = renderer;
  assert.ok(active);
  return {
    store: () => {
      assert.ok(latest);
      return latest;
    },
    renders: () => renders,
    rescope: (scope) => act(() => { active.update(createElement(Harness, { scope })); }),
    dispose: () => act(() => { active.unmount(); }),
  };
}

test('Given the same local session id on two hosts, when the scope switches host, then the active slot follows the new host', (t) => {
  // Given
  const harness = mount({ hostId: HOST_A, localHostId: HOST_A });
  t.after(harness.dispose);
  harness.store().setActiveSession(SESSION);
  act(() => { harness.store().appendRealtime(SESSION, message('a-1')); });
  const rendersAfterHostA = harness.renders();

  // When
  harness.rescope({ hostId: HOST_B, localHostId: HOST_A });
  const rendersAfterSwitch = harness.renders();
  act(() => { harness.store().appendRealtime(SESSION, message('b-1')); });

  // Then
  assert.deepEqual(harness.store().getMessages(SESSION).map((entry) => entry.id), ['b-1']);
  assert.ok(harness.renders() > rendersAfterSwitch, 'the new host slot must be active and notify its subscriber');
  assert.ok(rendersAfterHostA > 1, 'the first host slot was active before the switch');
});

test('Given a switch back to the first host, when its slot is read, then its own transcript is intact', (t) => {
  // Given
  const harness = mount({ hostId: HOST_A, localHostId: HOST_A });
  t.after(harness.dispose);
  harness.store().setActiveSession(SESSION);
  act(() => { harness.store().appendRealtime(SESSION, message('a-1')); });

  // When
  harness.rescope({ hostId: HOST_B, localHostId: HOST_A });
  act(() => { harness.store().appendRealtime(SESSION, message('b-1')); });
  harness.rescope({ hostId: HOST_A, localHostId: HOST_A });

  // Then
  assert.deepEqual(harness.store().getMessages(SESSION).map((entry) => entry.id), ['a-1']);
  assert.notEqual(sessionSlotKey(HOST_A, SESSION), sessionSlotKey(HOST_B, SESSION));
});

test('Given no active session, when the scope switches host, then nothing becomes active by accident', (t) => {
  // Given
  const harness = mount({ hostId: HOST_A, localHostId: HOST_A });
  t.after(harness.dispose);

  // When
  harness.rescope({ hostId: HOST_B, localHostId: HOST_A });
  const rendersBefore = harness.renders();
  act(() => { harness.store().appendRealtime(SESSION, message('b-1')); });

  // Then
  assert.equal(harness.renders(), rendersBefore);
  assert.deepEqual(harness.store().getMessages(SESSION).map((entry) => entry.id), ['b-1']);
});
