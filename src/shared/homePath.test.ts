import assert from 'node:assert/strict';
import test from 'node:test';

import { formatSuggestionLike, toHomeRelative } from './homePath';

const HOME = '/home/u';

// Regression: the 새 세션 작업 폴더 / 파일 패널 루트 autocomplete only understood
// bare home-relative input — typing '~/…' or an absolute path silently produced
// no suggestions at all (the endpoint rejects absolute prefixes by design).

test('toHomeRelative accepts bare, tilde, and absolute-under-home styles', () => {
  assert.equal(toHomeRelative('workspace/x', HOME), 'workspace/x');
  assert.equal(toHomeRelative('~/workspace/x', HOME), 'workspace/x');
  assert.equal(toHomeRelative('/home/u/workspace/x', HOME), 'workspace/x');
  assert.equal(toHomeRelative('~', HOME), '');
  assert.equal(toHomeRelative('/home/u', HOME), '');
  assert.equal(toHomeRelative('  ~/workspace/x  ', HOME), 'workspace/x');
});

test('toHomeRelative fails closed outside home or without a known home', () => {
  assert.equal(toHomeRelative('/etc/passwd', HOME), null, 'absolute outside home');
  assert.equal(toHomeRelative('/home/uother/x', HOME), null, 'prefix collision is not containment');
  assert.equal(toHomeRelative('/home/u/x', null), null, 'absolute input before HOME is known');
  assert.equal(toHomeRelative('', HOME), null);
  assert.equal(toHomeRelative('   ', HOME), null);
});

test('toHomeRelative tolerates a trailing slash on home', () => {
  assert.equal(toHomeRelative('/home/u/workspace', '/home/u/'), 'workspace');
});

test('formatSuggestionLike completes in the style the user is typing', () => {
  assert.equal(formatSuggestionLike('work', HOME, 'workspace'), 'workspace', 'bare stays bare');
  assert.equal(formatSuggestionLike('~/work', HOME, 'workspace'), '~/workspace');
  assert.equal(formatSuggestionLike('/home/u/work', HOME, 'workspace'), '/home/u/workspace');
  assert.equal(formatSuggestionLike('/home/u/work', null, 'workspace'), 'workspace', 'absolute style needs a known home');
});
