import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AUTH_TOKEN_STORAGE_KEY,
  clearSession,
  forgetLegacyStoredToken,
  getSessionSnapshot,
  isCurrentSessionSnapshot,
  markSessionActive,
  subscribeSession,
} from './authToken';

test('the browser keeps only a session marker and a generation, never a credential', () => {
  clearSession();
  const before = getSessionSnapshot();
  assert.equal(before.active, false);
  assert.equal(Object.keys(before).sort().join(','), 'active,generation', 'no token field exists to leak');

  const activated = markSessionActive();
  assert.equal(activated.active, true);
  assert.equal(activated.generation, before.generation + 1);
  assert.equal(markSessionActive().generation, activated.generation, 'repeat activation is idempotent');
});

test('a response captured before logout or re-login is recognized as stale', () => {
  clearSession();
  markSessionActive();
  const requestSnapshot = getSessionSnapshot();
  clearSession();
  assert.equal(isCurrentSessionSnapshot(requestSnapshot), false, 'logout invalidates in-flight work');
  markSessionActive();
  assert.equal(isCurrentSessionSnapshot(requestSnapshot), false, 'a new login is a new generation, not a resumption');
  assert.equal(isCurrentSessionSnapshot(getSessionSnapshot()), true);
});

test('subscribers see the current snapshot immediately and every change afterwards', () => {
  clearSession();
  const seen: boolean[] = [];
  const unsubscribe = subscribeSession((snapshot) => { seen.push(snapshot.active); });
  markSessionActive();
  clearSession();
  unsubscribe();
  markSessionActive();
  assert.deepEqual(seen, [false, true, false]);
});

test('a legacy stored token is removed and nothing is written back', () => {
  const store = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); },
  };
  try {
    store.set(AUTH_TOKEN_STORAGE_KEY, 'header.payload.signature');
    forgetLegacyStoredToken();
    markSessionActive();
    assert.equal(store.has(AUTH_TOKEN_STORAGE_KEY), false, 'the old JWT copy is gone');
    assert.equal(store.size, 0, 'no marker or token is persisted');
  } finally {
    delete (globalThis as { localStorage?: unknown }).localStorage;
    clearSession();
  }
});
