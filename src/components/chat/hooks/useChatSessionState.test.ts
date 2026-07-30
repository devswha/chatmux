import assert from 'node:assert/strict';
import test from 'node:test';

import { shouldReplaceSessionMessageWindow } from './useChatSessionState';

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
