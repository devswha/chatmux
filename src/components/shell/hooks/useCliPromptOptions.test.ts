import assert from 'node:assert/strict';
import test from 'node:test';

import { parseCliPromptOptions } from './useCliPromptOptions';

test('Given wrapped CLI choices, when prompt lines are parsed, then contiguous numbered options are returned', () => {
  // Given
  const lines = [
    'Choose an action',
    '  1. Continue with remote attach',
    '     on the selected host',
    '❯ 2. Reconnect terminal',
    'Enter to select · Esc to cancel',
  ];

  // When
  const options = parseCliPromptOptions(lines);

  // Then
  assert.deepEqual(options, [
    { number: '1', label: 'Continue with remote attach' },
    { number: '2', label: 'Reconnect terminal' },
  ]);
});

test('Given a numbering gap, when prompt lines are parsed, then no shortcuts are returned', () => {
  // Given
  const lines = ['1. First option', '3. Third option', 'Esc to cancel'];

  // When
  const options = parseCliPromptOptions(lines);

  // Then
  assert.equal(options, null);
});
