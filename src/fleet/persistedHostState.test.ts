import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LEGACY_LIVE_SESSION_ORDER_KEY,
  LEGACY_QUEUED_MESSAGE_PREFIX,
  LIVE_SESSION_ORDER_KEY,
  migrateLegacyPersistedState,
  queuedDraftKey,
  readPersistedSessionOrder,
  readQueuedDraft,
  writePersistedSessionOrder,
  writeQueuedDraft,
} from './persistedHostState';
import { sessionRef, sessionSlotKey } from './references';

const HOST_A = '11111111-1111-4111-8111-111111111111';
const HOST_B = '22222222-2222-4222-8222-222222222222';

function fakeStorage(seed: Readonly<Record<string, string>> = {}) {
  const entries = new Map<string, string>(Object.entries(seed));
  return {
    entries,
    keys: () => [...entries.keys()],
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => { entries.set(key, value); },
    removeItem: (key: string) => { entries.delete(key); },
  };
}

test('Given legacy bare drafts and an authoritative local host, when migrated, then they become host-qualified', () => {
  // Given
  const storage = fakeStorage({
    [`${LEGACY_QUEUED_MESSAGE_PREFIX}session-42`]: JSON.stringify({ content: 'local draft', options: { model: 'opus' } }),
    [`${LEGACY_QUEUED_MESSAGE_PREFIX}session-7`]: 'raw legacy text',
    'unrelated-app-key': 'keep me',
  });

  // When
  const outcome = migrateLegacyPersistedState(storage, HOST_A);

  // Then
  assert.equal(outcome.status, 'migrated');
  assert.equal(outcome.migratedDrafts, 2);
  assert.deepEqual(readQueuedDraft(storage, sessionRef(HOST_A, 'session-42')), {
    content: 'local draft',
    options: { model: 'opus' },
  });
  assert.deepEqual(readQueuedDraft(storage, sessionRef(HOST_A, 'session-7')), { content: 'raw legacy text' });
  assert.equal(storage.getItem(`${LEGACY_QUEUED_MESSAGE_PREFIX}session-42`), null);
  assert.equal(storage.getItem('unrelated-app-key'), 'keep me', 'unrelated keys are untouched');
});

test('Given no authoritative local host, when migration is attempted, then legacy pointers survive untouched', () => {
  // Given
  const legacyKey = `${LEGACY_QUEUED_MESSAGE_PREFIX}session-42`;
  const storage = fakeStorage({ [legacyKey]: JSON.stringify({ content: 'local draft' }) });

  // When
  const outcome = migrateLegacyPersistedState(storage, null);

  // Then
  assert.equal(outcome.status, 'identity-unknown');
  assert.equal(storage.getItem(legacyKey), JSON.stringify({ content: 'local draft' }));
});

test('Given a migration already recorded for the same host, when migration reruns, then it is a no-op', () => {
  // Given
  const storage = fakeStorage();
  writeQueuedDraft(storage, sessionRef(HOST_A, 'session-42'), { content: 'kept' });
  migrateLegacyPersistedState(storage, HOST_A);
  storage.setItem(`${LEGACY_QUEUED_MESSAGE_PREFIX}session-9`, JSON.stringify({ content: 'arrived later' }));

  // When
  const outcome = migrateLegacyPersistedState(storage, HOST_A);

  // Then
  assert.equal(outcome.status, 'already-migrated');
  assert.equal(readQueuedDraft(storage, sessionRef(HOST_A, 'session-9')), null, 'no second sweep attributes new bare ids');
  assert.deepEqual(readQueuedDraft(storage, sessionRef(HOST_A, 'session-42')), { content: 'kept' });
});

test('Given a different authoritative host than the recorded one, when migrated, then only ambiguous pointers drop', () => {
  // Given
  const storage = fakeStorage();
  migrateLegacyPersistedState(storage, HOST_A);
  writeQueuedDraft(storage, sessionRef(HOST_A, 'session-42'), { content: 'host a draft' });
  storage.setItem(`${LEGACY_QUEUED_MESSAGE_PREFIX}session-99`, JSON.stringify({ content: 'ambiguous' }));
  storage.setItem(LEGACY_LIVE_SESSION_ORDER_KEY, JSON.stringify(['session:session-99']));

  // When
  const outcome = migrateLegacyPersistedState(storage, HOST_B);

  // Then
  assert.equal(outcome.status, 'dropped-ambiguous');
  assert.equal(outcome.droppedPointers, 2);
  assert.equal(storage.getItem(`${LEGACY_QUEUED_MESSAGE_PREFIX}session-99`), null);
  assert.equal(storage.getItem(LEGACY_LIVE_SESSION_ORDER_KEY), null);
  assert.deepEqual(
    readQueuedDraft(storage, sessionRef(HOST_A, 'session-42')),
    { content: 'host a draft' },
    'host-qualified data of another host is never destroyed',
  );
  assert.equal(readQueuedDraft(storage, sessionRef(HOST_B, 'session-42')), null);
});

test('Given malformed legacy drafts, when migrated, then only those pointers drop', () => {
  // Given
  const storage = fakeStorage({
    [`${LEGACY_QUEUED_MESSAGE_PREFIX}session-blank`]: '   ',
    [`${LEGACY_QUEUED_MESSAGE_PREFIX}session-object`]: JSON.stringify({ options: { model: 'opus' } }),
    [`${LEGACY_QUEUED_MESSAGE_PREFIX}`]: JSON.stringify({ content: 'no session id' }),
    [`${LEGACY_QUEUED_MESSAGE_PREFIX}session-good`]: JSON.stringify({ content: 'survives' }),
  });

  // When
  const outcome = migrateLegacyPersistedState(storage, HOST_A);

  // Then
  assert.equal(outcome.migratedDrafts, 1);
  assert.equal(outcome.droppedPointers, 3);
  assert.deepEqual(readQueuedDraft(storage, sessionRef(HOST_A, 'session-good')), { content: 'survives' });
  assert.deepEqual(
    storage.keys().filter((key) => key.startsWith(LEGACY_QUEUED_MESSAGE_PREFIX)),
    [],
  );
});

test('Given one local id on two hosts, when drafts are written, then each host keeps its own draft', () => {
  // Given
  const storage = fakeStorage();

  // When
  writeQueuedDraft(storage, sessionRef(HOST_A, 'session-42'), { content: 'draft for a' });
  writeQueuedDraft(storage, sessionRef(HOST_B, 'session-42'), { content: 'draft for b' });

  // Then
  assert.notEqual(queuedDraftKey(sessionRef(HOST_A, 'session-42')), queuedDraftKey(sessionRef(HOST_B, 'session-42')));
  assert.deepEqual(readQueuedDraft(storage, sessionRef(HOST_A, 'session-42')), { content: 'draft for a' });
  assert.deepEqual(readQueuedDraft(storage, sessionRef(HOST_B, 'session-42')), { content: 'draft for b' });
});

test('Given a legacy sidebar order, when migrated, then entries become host-qualified and malformed rows drop', () => {
  // Given
  const storage = fakeStorage({
    [LEGACY_LIVE_SESSION_ORDER_KEY]: JSON.stringify([
      'session:session-42',
      'tmux:/tmp/a.sock\u0000$1\u0000@1\u0000%1',
      'garbage-entry',
      42,
    ]),
  });

  // When
  migrateLegacyPersistedState(storage, HOST_A);

  // Then
  const order = readPersistedSessionOrder(storage);
  assert.equal(order.length, 2);
  assert.ok(order.includes(sessionSlotKey(HOST_A, 'session-42')));
  assert.equal(storage.getItem(LEGACY_LIVE_SESSION_ORDER_KEY), null);
});

test('Given corrupt legacy order state, when migrated, then its pointer drops without creating an order', () => {
  // Given
  const storage = fakeStorage({ [LEGACY_LIVE_SESSION_ORDER_KEY]: '{' });

  // When
  const outcome = migrateLegacyPersistedState(storage, HOST_A);

  // Then
  assert.equal(outcome.status, 'migrated');
  assert.equal(outcome.droppedPointers, 1);
  assert.equal(storage.getItem(LEGACY_LIVE_SESSION_ORDER_KEY), null);
  assert.deepEqual(readPersistedSessionOrder(storage), []);
});

test('Given corrupt current order state, when read, then it is ignored without changing storage', () => {
  // Given
  const storage = fakeStorage({ [LIVE_SESSION_ORDER_KEY]: '{' });

  // When
  const order = readPersistedSessionOrder(storage);

  // Then
  assert.deepEqual(order, []);
  assert.equal(storage.getItem(LIVE_SESSION_ORDER_KEY), '{');
});

test('Given a versioned order payload from another version, when read, then it is ignored instead of trusted', () => {
  // Given
  const storage = fakeStorage({ [LIVE_SESSION_ORDER_KEY]: JSON.stringify({ version: 99, entries: ['x'] }) });

  // When / Then
  assert.deepEqual(readPersistedSessionOrder(storage), []);
});

test('Given a persisted order, when written and reread, then it round-trips', () => {
  // Given
  const storage = fakeStorage();
  const order = [sessionSlotKey(HOST_A, 'session-1'), sessionSlotKey(HOST_B, 'session-1')];

  // When
  writePersistedSessionOrder(storage, order);

  // Then
  assert.deepEqual(readPersistedSessionOrder(storage), order);
});
