import assert from 'node:assert/strict';
import test from 'node:test';

import {
  shouldApplySessionRefresh,
  shouldRefreshCachedImageWindow,
  shouldReplaceSessionMessageWindow,
} from './useChatSessionState';

test('same selected conversation preserves its expanded message window', () => {
  assert.equal(
    shouldReplaceSessionMessageWindow('session-1:project-1', 'session-1:project-1', true),
    false,
  );
});

test('conversation changes and missing cache restore the initial message window', () => {
  assert.equal(
    shouldReplaceSessionMessageWindow('session-1:project-1', 'session-2:project-1', true),
    true,
  );
  assert.equal(
    shouldReplaceSessionMessageWindow('session-1:project-1', 'session-1:project-1', false),
    true,
  );
});

test('re-enabling previews refreshes only an already-cached current conversation', () => {
  assert.equal(
    shouldRefreshCachedImageWindow('session-1:project-1', false, 'session-1:project-1', true, true),
    true,
  );
  assert.equal(
    shouldRefreshCachedImageWindow('session-1:project-1', true, 'session-1:project-1', true, true),
    false,
  );
  assert.equal(
    shouldRefreshCachedImageWindow('session-1:project-1', false, 'session-2:project-1', true, true),
    false,
  );
  assert.equal(
    shouldRefreshCachedImageWindow('session-1:project-1', false, 'session-1:project-1', true, false),
    false,
  );
});

test('cached image refresh cannot update a different selected conversation', () => {
  assert.equal(shouldApplySessionRefresh('session-1', 'session-1'), true);
  assert.equal(shouldApplySessionRefresh('session-1', 'session-2'), false);
  assert.equal(shouldApplySessionRefresh('session-1', null), false);
});
