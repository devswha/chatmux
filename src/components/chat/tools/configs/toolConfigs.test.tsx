import assert from 'node:assert/strict';
import test from 'node:test';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import ToolGroupContainer from '../../view/subcomponents/ToolGroupContainer';
import type { ChatMessage } from '../../types/types';
import type { ToolGroupItem } from '../../utils/toolGrouping';
import { ToolRenderer } from '../ToolRenderer';

import { parseOmpTodoResult } from './toolConfigs';

const RESULT_CONTENT = `Remaining items (2):
  - Implement parser [in_progress] (Implementation)
  - Ship fix [pending] (Verification)
Overall: 1/3 done, 2 open.
Active phase 1/2 "Implementation" (1/2).
 Implementation:
    - [X] Reproduce missing todo list
    - [ ] Implement parser (in progress)
 Verification:
    - [ ] Ship fix`;

const toolResult = {
  content: RESULT_CONTENT,
  isError: false,
};

function todoMessage(id: string, content = RESULT_CONTENT): ChatMessage {
  return {
    type: 'assistant',
    timestamp: '2026-08-02T12:00:00.000Z',
    isToolUse: true,
    toolName: 'todo',
    toolId: id,
    toolInput: { op: 'done', task: 'Reproduce missing todo list' },
    toolResult: { content, isError: false },
  };
}

test('parseOmpTodoResult reads the phase checklist without duplicating its summary', () => {
  assert.deepEqual(parseOmpTodoResult(toolResult), [
    { content: 'Reproduce missing todo list', status: 'completed' },
    { content: 'Implement parser', status: 'in_progress' },
    { content: 'Ship fix', status: 'pending' },
  ]);
});

test('lowercase OMP todo renders its result as a todo list', () => {
  const html = renderToStaticMarkup(createElement(ToolRenderer, {
    toolName: 'todo',
    toolId: 'todo-1',
    toolInput: { op: 'done', task: 'Reproduce missing todo list' },
    toolResult,
    mode: 'input',
  }));

  assert.match(html, /Todo list/);
  assert.match(html, /Reproduce missing todo list/);
  assert.match(html, /Implement parser/);
  assert.match(html, /Ship fix/);
  assert.doesNotMatch(html, /Parameters/);
});

test('consecutive OMP todo snapshots are expanded by default', () => {
  const group: ToolGroupItem = {
    _isGroup: true,
    toolName: 'todo',
    timestamp: '2026-08-02T12:00:00.000Z',
    messages: [todoMessage('todo-1'), todoMessage('todo-2')],
  };

  const html = renderToStaticMarkup(createElement(ToolGroupContainer, {
    group,
    prevMessage: null,
    createDiff: () => [],
    getMessageKey: (message) => String(message.toolId),
    provider: 'omp',
  }));

  assert.match(html, /Todo list/);
  assert.match(html, /x2/);
  assert.match(html, /Reproduce missing todo list/);
  assert.match(html, /aria-expanded="true"/);
});
