import assert from 'node:assert/strict';
import test from 'node:test';

import type { NormalizedMessage } from '../../../stores/useSessionStore';

import { normalizedToChatMessages } from './useChatMessages';

let nextId = 0;

function message(overrides: Partial<NormalizedMessage>): NormalizedMessage {
  nextId += 1;
  return {
    id: `message-${nextId}`,
    sessionId: 'session-1',
    timestamp: '2026-07-29T12:00:00.000Z',
    provider: 'claude',
    kind: 'text',
    ...overrides,
  };
}

test('suppresses realtime errors from a run that later succeeds', () => {
  const chat = normalizedToChatMessages([
    message({ role: 'user', content: 'Fix it' }),
    message({ kind: 'error', content: 'Transient transport error' }),
    message({ kind: 'complete', success: true, exitCode: 0 }),
  ]);

  assert.deepEqual(chat.map(({ type, content }) => ({ type, content })), [
    { type: 'user', content: 'Fix it' },
  ]);
});

test('suppresses historical provider errors when the turn still produced a final answer', () => {
  const chat = normalizedToChatMessages([
    message({ role: 'user', content: 'Inspect it' }),
    message({ kind: 'error', content: 'Recoverable provider stderr' }),
    message({ role: 'assistant', content: 'The inspection completed.' }),
  ]);

  assert.deepEqual(chat.map(({ type, content }) => ({ type, content })), [
    { type: 'user', content: 'Inspect it' },
    { type: 'assistant', content: 'The inspection completed.' },
  ]);
});

test('suppresses realtime errors from an aborted run', () => {
  const chat = normalizedToChatMessages([
    message({ role: 'user', content: 'Stop this' }),
    message({ kind: 'error', content: 'Process terminated' }),
    message({ kind: 'complete', success: false, aborted: true, exitCode: 1 }),
  ]);

  assert.equal(chat.some((item) => item.type === 'error'), false);
});

test('retains only the final standalone error from a failed run', () => {
  const chat = normalizedToChatMessages([
    message({ role: 'user', content: 'Run task' }),
    message({ kind: 'error', content: 'stderr line one' }),
    message({ kind: 'error', content: 'Final failure' }),
    message({ kind: 'complete', success: false, exitCode: 1 }),
  ]);

  assert.deepEqual(chat.filter((item) => item.type === 'error').map((item) => item.content), ['Final failure']);
});

test('retains legacy standalone errors without completion evidence', () => {
  const chat = normalizedToChatMessages([
    message({ role: 'user', content: 'Old task' }),
    message({ kind: 'error', content: 'Historical failure' }),
  ]);

  assert.deepEqual(chat.filter((item) => item.type === 'error').map((item) => item.content), ['Historical failure']);
});

test('renders a task notification result without its redundant completed summary', () => {
  const chat = normalizedToChatMessages([
    message({
      role: 'user',
      content: '<task-notification><status>completed</status><summary>Task completed</summary><result>## Result\nDone.</result></task-notification>',
    }),
  ]);

  assert.deepEqual(chat.map(({ type, content, isTaskNotification }) => ({ type, content, isTaskNotification })), [
    { type: 'assistant', content: '## Result\nDone.', isTaskNotification: undefined },
  ]);

  const summaryOnly = normalizedToChatMessages([
    message({
      role: 'user',
      content: '<task-notification><status>completed</status><summary>Task completed</summary></task-notification>',
    }),
  ]);
  assert.deepEqual(summaryOnly.map(({ content, isTaskNotification }) => ({ content, isTaskNotification })), [
    { content: 'Task completed', isTaskNotification: true },
  ]);
});
