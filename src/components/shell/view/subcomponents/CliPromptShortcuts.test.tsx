import assert from 'node:assert/strict';
import test from 'node:test';

import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';

import { CliPromptShortcuts } from './CliPromptShortcuts';

test('Given CLI prompt shortcuts, when an option and escape are pressed, then terminal inputs are sent', async () => {
  // Given
  const inputs: string[] = [];
  const renderer = TestRenderer.create(createElement(CliPromptShortcuts, {
    options: [{ number: '1', label: 'Continue' }, { number: '2', label: 'Reconnect' }],
    onInput: (data: string) => inputs.push(data),
  }));

  // When
  const buttons = renderer.root.findAllByType('button');
  await act(async () => {
    buttons[1]?.props.onClick();
    buttons[2]?.props.onClick();
  });

  // Then
  assert.deepEqual(inputs, ['2', '\x1b']);
  await act(async () => renderer.unmount());
});
