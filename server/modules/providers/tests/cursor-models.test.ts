import assert from 'node:assert/strict';
import test from 'node:test';

import { parseCursorModelEffort } from '@/modules/providers/list/cursor/cursor-models.provider.js';

test('parseCursorModelEffort reads reasoning depth encoded in Cursor model ids', () => {
  assert.equal(parseCursorModelEffort('gpt-5.5-high-fast'), 'high');
  assert.equal(parseCursorModelEffort('gpt-5.1-codex-max-medium'), 'medium');
  assert.equal(parseCursorModelEffort('claude-4.6-opus-high-thinking'), 'high');
  assert.equal(parseCursorModelEffort('gpt-5.5-extra-high'), 'xhigh');
  assert.equal(parseCursorModelEffort('gpt-5.5-none-fast'), 'none');
});

test('parseCursorModelEffort does not mistake speed or model names for effort', () => {
  assert.equal(parseCursorModelEffort('composer-2.5-fast'), null);
  assert.equal(parseCursorModelEffort('claude-haiku-4-5'), null);
  assert.equal(parseCursorModelEffort('auto'), null);
});
