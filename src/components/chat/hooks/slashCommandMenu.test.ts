import assert from 'node:assert/strict';
import test from 'node:test';

import { buildSlashCommandInsertion, findSlashCommandQuery } from './slashCommandMenu';

test('Given a slash token after whitespace, when the cursor reaches it, then the menu query includes its position', () => {
  // Given
  const value = 'draft /review remaining';

  // When
  const query = findSlashCommandQuery(value, 'draft /review'.length);

  // Then
  assert.deepEqual(query, { slashPosition: 6, query: 'review' });
});

test('Given a slash token inside a fenced code block, when the cursor reaches it, then the menu stays closed', () => {
  // Given
  const value = '```ts\n/run';

  // When
  const query = findSlashCommandQuery(value, value.length);

  // Then
  assert.equal(query, null);
});

test('Given an active slash token with trailing text, when a command is inserted, then only the token is replaced and the cursor follows it', () => {
  // Given
  const selection = {
    value: 'draft /rev keep this',
    selectionStart: 10,
    selectionEnd: 10,
    slashPosition: 6,
  };

  // When
  const insertion = buildSlashCommandInsertion(selection, '/review');

  // Then
  assert.deepEqual(insertion, {
    value: 'draft /review keep this',
    cursorPosition: 14,
  });
});

test('Given no active slash token, when a command is inserted at a selection, then it replaces the selection with existing spacing behavior', () => {
  // Given
  const selection = {
    value: 'draft old tail',
    selectionStart: 6,
    selectionEnd: 9,
    slashPosition: -1,
  };

  // When
  const insertion = buildSlashCommandInsertion(selection, '/review');

  // Then
  assert.deepEqual(insertion, {
    value: 'draft /review  tail',
    cursorPosition: 14,
  });
});
