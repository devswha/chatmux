import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseExternalJsonlActivity,
  parseOpenCodeActivity,
} from '@/modules/providers/services/external-session-activity.service.js';

const line = (value: unknown) => JSON.stringify(value);

test('Oh My Pi activity follows the final turn-relevant JSONL message', () => {
  assert.equal(parseExternalJsonlActivity('omp', [
    line({ type: 'message', message: { role: 'user', content: 'go' } }),
    line({ type: 'message', message: { role: 'assistant', stopReason: 'toolUse', content: [] } }),
    line({ type: 'message', message: { role: 'toolResult', content: 'ok' } }),
  ].join('\n')), 'running');
  assert.equal(parseExternalJsonlActivity('omp', line({
    type: 'message',
    message: { role: 'assistant', stopReason: 'stop', content: [] },
  })), 'waiting_user');
});

test('Oh My Pi recognizes a native user question inside a tool-use turn', () => {
  assert.equal(parseExternalJsonlActivity('omp', line({
    type: 'message',
    message: {
      role: 'assistant',
      content: [{ type: 'toolCall', name: 'ask' }],
    },
  })), 'asking_user');
});

test('Claude activity distinguishes tool execution, questions, and completed turns', () => {
  assert.equal(parseExternalJsonlActivity('claude', line({
    type: 'assistant',
    message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'Bash' }] },
  })), 'running');
  assert.equal(parseExternalJsonlActivity('claude', line({
    type: 'assistant',
    message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'AskUserQuestion' }] },
  })), 'asking_user');
  assert.equal(parseExternalJsonlActivity('claude', line({
    type: 'assistant',
    message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] },
  })), 'waiting_user');
});

test('Codex activity uses explicit task lifecycle events and request_user_input', () => {
  assert.equal(parseExternalJsonlActivity('codex', [
    line({ type: 'event_msg', payload: { type: 'task_complete' } }),
    line({ type: 'event_msg', payload: { type: 'task_started' } }),
  ].join('\n')), 'running');
  assert.equal(parseExternalJsonlActivity('codex', line({
    type: 'response_item',
    payload: { type: 'function_call', name: 'request_user_input' },
  })), 'asking_user');
  assert.equal(parseExternalJsonlActivity('codex', line({
    type: 'event_msg',
    payload: { type: 'task_complete' },
  })), 'waiting_user');
});

test('Cursor activity fails closed and treats unfinished tools as running', () => {
  assert.equal(parseExternalJsonlActivity('cursor', line({
    role: 'assistant',
    content: [{ type: 'tool-call', toolName: 'Read' }],
  })), 'running');
  assert.equal(parseExternalJsonlActivity('cursor', line({
    role: 'assistant',
    content: [{ type: 'text', text: 'done' }],
  })), 'waiting_user');
  assert.equal(parseExternalJsonlActivity('cursor', 'not-json'), 'unknown');
});

test('OpenCode activity uses assistant completion and pending question parts', () => {
  assert.equal(parseOpenCodeActivity({
    role: 'assistant',
    time: { created: 1 },
  }), 'running');
  assert.equal(parseOpenCodeActivity({
    role: 'assistant',
    time: { created: 1 },
  }, [{ type: 'tool', tool: 'question', state: { status: 'running' } }]), 'asking_user');
  assert.equal(parseOpenCodeActivity({
    role: 'assistant',
    time: { created: 1, completed: 2 },
    finish: 'tool-calls',
  }), 'running');
  assert.equal(parseOpenCodeActivity({
    role: 'assistant',
    time: { created: 1, completed: 2 },
    finish: 'stop',
  }), 'waiting_user');
  assert.equal(parseOpenCodeActivity({
    role: 'assistant',
    time: { created: 1, completed: 2 },
    error: { name: 'APIError' },
  }), 'waiting_user');
});
