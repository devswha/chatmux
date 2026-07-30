import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applySessionOrder,
  createSessionOrderId,
  LIVE_SESSION_ORDER_STORAGE_KEY,
  migrateSessionOrderAliases,
  mergeVisibleSessionOrder,
  moveSession,
  parseStoredSessionOrder,
  persistSessionOrder,
  readStoredSessionOrder,
} from './sessionOrder';

test('parseStoredSessionOrder rejects malformed values and removes invalid duplicates', () => {
  assert.deepEqual(parseStoredSessionOrder(null), []);
  assert.deepEqual(parseStoredSessionOrder('{bad json'), []);
  assert.deepEqual(parseStoredSessionOrder('{"id":"a"}'), []);
  assert.deepEqual(
    parseStoredSessionOrder('["second", "", 3, "first", "second"]'),
    ['second', 'first'],
  );
});

test('createSessionOrderId keeps a pane in place when its synthetic session id is promoted', () => {
  const tmux = {
    socketPath: '/tmp/chatmux.sock',
    sessionId: '$1',
    windowId: '@2',
    paneId: '%3',
  };

  assert.equal(
    createSessionOrderId('idle-gjc:stock', tmux),
    createSessionOrderId('app-session-id', tmux),
  );
  assert.notEqual(
    createSessionOrderId('app-session-id', tmux),
    createSessionOrderId('app-session-id', { ...tmux, paneId: '%4' }),
  );
});

test('migrateSessionOrderAliases keeps a reordered GJC row in place when its pane target arrives', () => {
  const fallback = createSessionOrderId('gjc-session');
  const pane = createSessionOrderId('gjc-session', {
    socketPath: '/tmp/chatmux.sock',
    sessionId: '$1',
    windowId: '@2',
    paneId: '%3',
  });

  assert.deepEqual(
    migrateSessionOrderAliases(
      ['external-before', fallback, pane, 'external-after'],
      new Map([[fallback, pane]]),
    ),
    ['external-before', pane, 'external-after'],
  );
});

test('persistSessionOrder restores the custom order across component mounts', () => {
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const storage = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
  });

  try {
    persistSessionOrder(['third', 'first', 'second']);
    assert.equal(
      storage.get(LIVE_SESSION_ORDER_STORAGE_KEY),
      '["third","first","second"]',
    );
    assert.deepEqual(readStoredSessionOrder(), ['third', 'first', 'second']);
  } finally {
    if (originalStorage) {
      Object.defineProperty(globalThis, 'localStorage', originalStorage);
    } else {
      delete (globalThis as { localStorage?: Storage }).localStorage;
    }
  }
});

test('session order stays page-local when storage get or set throws', () => {
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: () => { throw new Error('storage unavailable'); },
      setItem: () => { throw new Error('storage unavailable'); },
    },
  });

  try {
    assert.deepEqual(readStoredSessionOrder(), []);
    assert.doesNotThrow(() => persistSessionOrder(['second', 'first']));
    assert.deepEqual(moveSession(['first', 'second'], 'second', 'first'), ['second', 'first']);
  } finally {
    if (originalStorage) {
      Object.defineProperty(globalThis, 'localStorage', originalStorage);
    } else {
      delete (globalThis as { localStorage?: Storage }).localStorage;
    }
  }
});

test('applySessionOrder keeps persisted rows first and appends newly discovered sessions', () => {
  const rows = [{ id: 'new' }, { id: 'first' }, { id: 'second' }];

  assert.deepEqual(
    applySessionOrder(rows, ['missing', 'second', 'first'], (row) => row.id),
    [{ id: 'second' }, { id: 'first' }, { id: 'new' }],
  );
});

test('mergeVisibleSessionOrder preserves temporarily hidden session slots', () => {
  assert.deepEqual(
    mergeVisibleSessionOrder(
      ['visible-a', 'hidden-b', 'visible-c'],
      ['visible-c', 'visible-a'],
    ),
    ['visible-c', 'hidden-b', 'visible-a'],
  );
  assert.deepEqual(
    mergeVisibleSessionOrder(
      ['visible-a', 'hidden-b', 'visible-c'],
      ['visible-c', 'new-d', 'visible-a'],
    ),
    ['visible-c', 'hidden-b', 'new-d', 'visible-a'],
  );
});

test('mergeVisibleSessionOrder keeps current sessions when pruning stale history', () => {
  const staleOrder = Array.from({ length: 200 }, (_, index) => `hidden-${index}`);

  const merged = mergeVisibleSessionOrder(staleOrder, ['visible-now']);

  assert.equal(merged.length, 200);
  assert.ok(merged.includes('visible-now'));
});

test('moveSession moves in both directions without losing rows', () => {
  assert.deepEqual(moveSession(['a', 'b', 'c'], 'a', 'c'), ['b', 'c', 'a']);
  assert.deepEqual(moveSession(['a', 'b', 'c'], 'c', 'a'), ['c', 'a', 'b']);
  assert.deepEqual(moveSession(['a', 'b', 'c'], 'missing', 'b'), ['a', 'b', 'c']);
});
