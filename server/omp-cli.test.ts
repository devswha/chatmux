import assert from 'node:assert/strict';
import test from 'node:test';

import { buildOmpArgs, normalizeOmpEvent } from './omp-cli.js';

test('buildOmpArgs preserves resume, model, thinking, images, and prompt as distinct argv', () => {
  assert.deepEqual(
    buildOmpArgs('Explain this image', {
      sessionId: '019f87e4-f3f3-7000-897a-e9a6a19c3edd',
      model: 'openai-codex/gpt-5.6-sol',
      effort: 'high',
      images: [{ path: '/tmp/chatmux-assets/image.png' }],
    }),
    [
      '--mode',
      'json',
      '--print',
      '--resume',
      '019f87e4-f3f3-7000-897a-e9a6a19c3edd',
      '--model',
      'openai-codex/gpt-5.6-sol',
      '--thinking',
      'high',
      '@/tmp/chatmux-assets/image.png',
      'Explain this image',
    ],
  );
});

test('normalizeOmpEvent captures the native session id and streams assistant text', () => {
  assert.deepEqual(
    normalizeOmpEvent({ type: 'session', id: 'omp-session-1' }, null),
    { providerSessionId: 'omp-session-1', messages: [] },
  );

  const result = normalizeOmpEvent({
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', delta: 'hello' },
  }, 'omp-session-1');

  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0]?.provider, 'omp');
  assert.equal(result.messages[0]?.sessionId, 'omp-session-1');
  assert.equal(result.messages[0]?.kind, 'stream_delta');
  assert.equal(result.messages[0]?.content, 'hello');
});

test('normalizeOmpEvent maps native tool lifecycle events to shared tool messages', () => {
  const started = normalizeOmpEvent({
    type: 'tool_execution_start',
    toolCallId: 'call-1',
    toolName: 'bash',
    args: { command: 'pwd' },
  }, 'omp-session-1').messages[0];
  assert.deepEqual(
    {
      provider: started?.provider,
      sessionId: started?.sessionId,
      kind: started?.kind,
      toolName: started?.toolName,
      toolInput: started?.toolInput,
      toolId: started?.toolId,
    },
    {
      provider: 'omp',
      sessionId: 'omp-session-1',
      kind: 'tool_use',
      toolName: 'bash',
      toolInput: { command: 'pwd' },
      toolId: 'call-1',
    },
  );

  const ended = normalizeOmpEvent({
    type: 'tool_execution_end',
    toolCallId: 'call-1',
    result: { content: [{ type: 'text', text: '/tmp' }] },
    isError: false,
  }, 'omp-session-1').messages[0];
  assert.equal(ended?.kind, 'tool_result');
  assert.equal(ended?.toolId, 'call-1');
  assert.equal(ended?.content, '/tmp');
  assert.equal(ended?.isError, false);
});
