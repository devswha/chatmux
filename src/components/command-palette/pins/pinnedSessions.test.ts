import assert from 'node:assert/strict';
import test from 'node:test';

import {
  browserPinStorage,
  MAX_PINNED_SESSIONS,
  MAX_PINNED_STORAGE_LENGTH,
  parsePinnedSession,
  parsePinnedSessions,
  PINNED_SESSIONS_KEY,
  pinnedSessionKey,
  readPinnedSessions,
  togglePinnedSession,
  writePinnedSessions,
  type PinnedSession,
} from './pinnedSessions';

const HOST = '11111111-1111-4111-8111-111111111111';
const PEER = '22222222-2222-4222-8222-222222222222';
const pin: PinnedSession = { hostId: HOST, projectId: 'project', sessionId: 'session' };
const encode = (pins: readonly unknown[]) => JSON.stringify({ version: 1, pins });

test('pin persistence keeps only validated identities, deduplicates, and never serializes display or action material', () => {
  const untrusted = { ...pin, label: 'private title', capabilities: ['terminal.input'], transcriptPath: '/private/transcript', socketPath: '/private/socket', token: 'private-token' };
  assert.deepEqual(parsePinnedSessions(encode([untrusted, pin, { ...pin, hostId: PEER }])), [pin, { ...pin, hostId: PEER }]);
  let saved = '';
  assert.equal(writePinnedSessions({ getItem: () => null, setItem: (key, value) => {
    assert.equal(key, PINNED_SESSIONS_KEY);
    saved = value;
  } }, [untrusted]), true);
  assert.equal(saved, encode([pin]));
  assert.doesNotMatch(saved, /private|capabilit|transcript|socket|token|label/);
});

test('corrupt, unsupported and oversized storage fails closed without throwing', () => {
  for (const raw of [null, '', '{', 'null', '[]', '42', '{"version":2,"pins":[]}', '{"version":1,"pins":{}}', ' '.repeat(MAX_PINNED_STORAGE_LENGTH + 1), encode(Array(MAX_PINNED_SESSIONS + 1).fill(pin))]) {
    assert.deepEqual(parsePinnedSessions(raw), []);
  }
  for (const value of [null, [], {}, { ...pin, hostId: null }, { ...pin, hostId: 'hostunknown' }, { ...pin, hostId: '/socket' }, { ...pin, projectId: '' }, { ...pin, projectId: 1 }, { ...pin, sessionId: 'x\0y' }, { ...pin, sessionId: 'x'.repeat(257) }]) {
    assert.equal(parsePinnedSession(value), null);
  }
  assert.deepEqual(parsePinnedSessions(encode([{ ...pin, hostId: null }, pin])), [pin]);
  assert.equal(parsePinnedSession({ ...pin, projectId: '\ud800' }), null);
  assert.equal(parsePinnedSession({ ...pin, sessionId: '\udfff' }), null);
});

test('host and project qualified keys cannot collide on delimiters or multi-byte IDs', () => {
  const records = [
    pin,
    { ...pin, hostId: PEER },
    { ...pin, projectId: 'a:b', sessionId: 'c' },
    { ...pin, projectId: 'a', sessionId: 'b:c' },
    { ...pin, projectId: '한:글', sessionId: '😀' },
  ];
  assert.equal(new Set(records.map(pinnedSessionKey)).size, records.length);
  assert.deepEqual(parsePinnedSessions(encode(records)), records);
});

test('the twelve-pin bound refuses additions without evicting or reordering existing pins', () => {
  let pins: readonly PinnedSession[] = [];
  for (let index = 0; index < MAX_PINNED_SESSIONS; index++) {
    pins = togglePinnedSession(pins, { ...pin, sessionId: String(index) });
  }
  const full = pins;
  assert.strictEqual(togglePinnedSession(full, { ...pin, sessionId: 'extra' }), full);
  assert.strictEqual(togglePinnedSession(full, { ...pin, hostId: null }), full);
  pins = togglePinnedSession(full, full[3]);
  assert.deepEqual(pins, full.filter((_, index) => index !== 3));
  pins = togglePinnedSession(pins, { ...pin, hostId: PEER });
  assert.equal(pins.length, MAX_PINNED_SESSIONS);
  assert.equal(pins.at(-1)?.hostId, PEER);
});

test('read, write and browser storage access denial never escape', () => {
  const denied = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('quota'); } };
  assert.deepEqual(readPinnedSessions(denied), []);
  assert.equal(writePinnedSessions(denied, [pin]), false);
  assert.deepEqual(readPinnedSessions(null), []);
  assert.equal(writePinnedSessions(null, [pin]), false);
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window');
  try {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: {
      get localStorage() { throw new Error('access denied'); },
    } });
    assert.equal(browserPinStorage(), null);
  } finally {
    if (original) Object.defineProperty(globalThis, 'window', original);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});
