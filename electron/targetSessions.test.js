import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LOCAL_TARGET_PARTITION,
  TARGET_STORAGE_TYPES,
  clearTargetSessionData,
  getTargetPartition,
  isTargetUrlAllowed,
} from './targetSessions.js';

const TARGET_A = {
  kind: 'remote',
  id: 'c6d51c92-5f1a-4e0b-a113-c34f56ddf2da',
  name: 'Target A',
  url: 'https://app.example.test:8443',
};

const TARGET_B = {
  kind: 'remote',
  id: 'f8af010e-4052-4dc8-955b-990540b2e49b',
  name: 'Target B',
  url: 'https://app.example.test',
};

function createSession() {
  const calls = [];
  return {
    calls,
    cookies: {
      get: async () => [
        { domain: '.app.example.test', path: '/', name: 'session', secure: true },
      ],
      remove: async (url, name) => calls.push(['remove-cookie', url, name]),
    },
    clearCache: async () => calls.push(['clear-cache']),
    clearStorageData: async (options) => calls.push(['clear-storage', options]),
    clearAuthCache: async () => calls.push(['clear-auth-cache']),
  };
}

test('dedicated partitions prevent Local and remote targets from sharing state', () => {
  assert.equal(getTargetPartition({ kind: 'local', id: 'local' }), LOCAL_TARGET_PARTITION);
  assert.equal(getTargetPartition(TARGET_A), 'persist:chatmux-target-c6d51c92-5f1a-4e0b-a113-c34f56ddf2da');
  assert.notEqual(getTargetPartition(TARGET_A), getTargetPartition(TARGET_B));
  assert.throws(() => getTargetPartition({ kind: 'remote', id: 'not-an-opaque-id' }));
});

test('target navigation accepts only the registered scheme, host, and port', () => {
  assert.equal(isTargetUrlAllowed(TARGET_A, 'https://app.example.test:8443/session/123'), true);
  assert.equal(isTargetUrlAllowed(TARGET_A, 'http://app.example.test:8443/session/123'), false);
  assert.equal(isTargetUrlAllowed(TARGET_A, 'https://app.example.test/session/123'), false);
  assert.equal(isTargetUrlAllowed(TARGET_A, 'https://other.example.test:8443/session/123'), false);
  assert.equal(isTargetUrlAllowed(TARGET_A, 'data:text/html,credential-leak'), false);
});

test('editing or deleting a target clears only that target partition before reuse', async () => {
  const sessions = new Map([
    [getTargetPartition(TARGET_A), createSession()],
    [getTargetPartition(TARGET_B), createSession()],
  ]);
  const resolveSession = (partition) => sessions.get(partition);

  await clearTargetSessionData(TARGET_A, resolveSession);

  const targetACalls = sessions.get(getTargetPartition(TARGET_A)).calls;
  const targetBCalls = sessions.get(getTargetPartition(TARGET_B)).calls;
  assert.deepEqual(targetACalls.map(([name]) => name), [
    'remove-cookie',
    'clear-cache',
    'clear-storage',
    'clear-auth-cache',
  ]);
  assert.deepEqual(targetACalls[2][1].storages, TARGET_STORAGE_TYPES);
  assert.deepEqual(targetBCalls, []);
});
