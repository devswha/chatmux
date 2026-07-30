import assert from 'node:assert/strict';
import test from 'node:test';

import { readRestSessionContainer } from '../utils/liveSessions';

import {
  normalizePersistedTab,
  resolveLiveDiscoverySession,
  shouldApplyLiveRestResponse,
} from './useProjectsState';

test('only chat remains a valid persisted main tab', () => {
  assert.equal(normalizePersistedTab('chat'), 'chat');
});

test('every removed or malformed persisted tab normalizes to chat', () => {
  for (const tab of ['git', 'files', 'shell', 'tasks', 'browser', 'plugin:example', '', 'unknown']) {
    assert.equal(normalizePersistedTab(tab), 'chat', tab);
  }
  assert.equal(normalizePersistedTab(null), 'chat');
});

test('healthy discovery rows own identity and activity over stale REST metadata', () => {
  const row = {
    key: 'live:/tmp/tmux:%1',
    lane: 'live' as const,
    tmuxName: 'chatmux',
    tmux: { socketPath: '/tmp/tmux', sessionId: '$1', windowId: '@1', paneId: '%1' },
    process: { pid: 123, startedAtMs: 1_700_000_000_000 },
    kind: 'gjc',
    providerSessionId: 'stream-session',
    activity: 'error' as const,
    cwd: null,
    presence: 'present' as const,
  };

  const mismatched = resolveLiveDiscoverySession(row, {
    id: 'stale-rest-session',
    running: true,
    error: false,
  });
  assert.equal(mismatched?.sessionId, 'stream-session');
  assert.equal(mismatched?.metadata, undefined);
  assert.equal(mismatched?.running, false);
  assert.equal(mismatched?.error, true);

  const matching = resolveLiveDiscoverySession(
    { ...row, activity: 'unknown' },
    { id: 'stream-session', running: true, error: true, model: 'claude-opus-5' },
  );
  assert.equal(matching?.metadata?.model, 'claude-opus-5');
  assert.equal(matching?.running, false, 'REST running must not override a healthy stream');
  assert.equal(matching?.error, false, 'REST error must not override a healthy stream');
});
test('live request fencing rejects deferred, recovered, and unmounted responses', () => {
  assert.equal(shouldApplyLiveRestResponse(2, 2, 1, false), true);
  assert.equal(
    shouldApplyLiveRestResponse(1, 2, 0, false),
    false,
    'a deferred bootstrap result cannot overwrite a newer fallback',
  );
  assert.equal(
    shouldApplyLiveRestResponse(2, 3, 1, false),
    false,
    'stream recovery invalidates an in-flight REST request',
  );
  assert.equal(
    shouldApplyLiveRestResponse(3, 3, 2, true),
    false,
    'unmount abort prevents a late response from applying',
  );
});
test('a malformed newest live container fences an older successful response', () => {
  let appliedGeneration = 0;
  const latestGeneration = 2;
  assert.equal(
    shouldApplyLiveRestResponse(2, latestGeneration, appliedGeneration, false),
    true,
  );
  assert.equal(
    readRestSessionContainer({ data: { liveSessions: 'invalid' } }, 'liveSessions'),
    null,
  );
  appliedGeneration = 2;
  assert.equal(
    shouldApplyLiveRestResponse(1, latestGeneration, appliedGeneration, false),
    false,
  );
});
test('false discovery keeps a reported live row to stable identity only', () => {
  const row = {
    key: 'live:/tmp/tmux:%1',
    lane: 'live' as const,
    tmuxName: 'chatmux',
    tmux: { socketPath: '/tmp/tmux', sessionId: '$1', windowId: '@1', paneId: '%1' },
    process: { pid: 123, startedAtMs: 1_700_000_000_000 },
    kind: 'gjc',
    providerSessionId: 'present-session',
    activity: 'running' as const,
    cwd: '/workspace/project',
    presence: 'present' as const,
  };
  assert.deepEqual(resolveLiveDiscoverySession(row, {
    id: 'present-session',
    model: 'claude-opus-5',
    effort: 'high',
    claim: 'lineage',
    running: true,
    error: true,
  }, false), {
    sessionId: 'present-session',
    running: false,
    error: false,
  });
});
