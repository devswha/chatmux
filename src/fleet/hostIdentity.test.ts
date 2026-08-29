import assert from 'node:assert/strict';
import test from 'node:test';

import {
  activeSessionHostId,
  clearHostIdentity,
  localHostId,
  localHostIdentity,
  setActiveSessionHostId,
  setLocalHostIdentity,
  subscribeHostIdentity,
} from './hostIdentity';

const HOST_A = '11111111-1111-4111-8111-111111111111';
const HOST_B = '22222222-2222-4222-8222-222222222222';

test('Given a server-supplied host id, when recorded, then subscribers see one authoritative identity', (t) => {
  // Given
  t.after(clearHostIdentity);
  const notifications: string[] = [];
  const unsubscribe = subscribeHostIdentity(() => {
    notifications.push(localHostId() ?? 'unknown');
  });
  t.after(unsubscribe);

  // When
  setLocalHostIdentity(HOST_A);
  setLocalHostIdentity(HOST_A);

  // Then
  assert.deepEqual(localHostIdentity(), { kind: 'known', hostId: HOST_A });
  assert.deepEqual(notifications, [HOST_A], 'an unchanged identity does not notify');
});

test('Given malformed identity payloads, when recorded, then the identity stays unknown', (t) => {
  // Given
  t.after(clearHostIdentity);

  // When
  setLocalHostIdentity('not-a-uuid');
  setLocalHostIdentity(undefined);
  setLocalHostIdentity({ installationId: HOST_A });

  // Then
  assert.deepEqual(localHostIdentity(), { kind: 'unknown' });
  assert.equal(localHostId(), null);
});

test('Given an active route host, when it changes, then only canonical host ids are adopted', (t) => {
  // Given
  t.after(clearHostIdentity);

  // When
  setActiveSessionHostId(HOST_B);
  const adopted = activeSessionHostId();
  setActiveSessionHostId('not-a-uuid');

  // Then
  assert.equal(adopted, HOST_B);
  assert.equal(activeSessionHostId(), null, 'a malformed host is not an active host');
});

test('Given a recorded identity, when the auth boundary clears it, then nothing is remembered', (t) => {
  // Given
  t.after(clearHostIdentity);
  setLocalHostIdentity(HOST_A);
  setActiveSessionHostId(HOST_B);

  // When
  clearHostIdentity();

  // Then
  assert.deepEqual(localHostIdentity(), { kind: 'unknown' });
  assert.equal(activeSessionHostId(), null);
});
