import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CHAT_COMPOSER_MAX_HEIGHT,
  CHAT_COMPOSER_MIN_HEIGHT,
  clampChatComposerHeight,
  getChatComposerMaxHeight,
  getDraggedChatComposerHeight,
  parseStoredChatComposerHeight,
} from './chatComposerResize';

test('composer height stays between its minimum and the smaller viewport or desktop maximum', () => {
  assert.equal(getChatComposerMaxHeight(600), 300);
  assert.equal(getChatComposerMaxHeight(1200), CHAT_COMPOSER_MAX_HEIGHT);
  assert.equal(clampChatComposerHeight(10, 600), CHAT_COMPOSER_MIN_HEIGHT);
  assert.equal(clampChatComposerHeight(900, 600), 300);
});

test('dragging the top handle upward grows the composer and downward shrinks it', () => {
  assert.equal(getDraggedChatComposerHeight(120, 300, 240, 800), 180);
  assert.equal(getDraggedChatComposerHeight(120, 300, 360, 800), 60);
  assert.equal(getDraggedChatComposerHeight(120, 300, 500, 800), CHAT_COMPOSER_MIN_HEIGHT);
});

test('stored composer heights accept only finite positive numbers', () => {
  assert.equal(parseStoredChatComposerHeight('180'), 180);
  assert.equal(parseStoredChatComposerHeight(null), null);
  assert.equal(parseStoredChatComposerHeight(''), null);
  assert.equal(parseStoredChatComposerHeight('invalid'), null);
  assert.equal(parseStoredChatComposerHeight('-20'), null);
});
