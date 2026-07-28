import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizePersistedTab } from './useProjectsState';

test('only chat remains a valid persisted main tab', () => {
  assert.equal(normalizePersistedTab('chat'), 'chat');
});

test('every removed or malformed persisted tab normalizes to chat', () => {
  for (const tab of ['git', 'files', 'shell', 'tasks', 'browser', 'plugin:example', '', 'unknown']) {
    assert.equal(normalizePersistedTab(tab), 'chat', tab);
  }
  assert.equal(normalizePersistedTab(null), 'chat');
});
