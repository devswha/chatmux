import assert from 'node:assert/strict';
import test from 'node:test';

import { buildOmoArgs, normalizeOmoEvent } from './omo-cli.js';
import { buildOmpArgs } from './omp-cli.js';

test('buildOmoArgs continues a session with --session-id, never --resume', () => {
  assert.deepEqual(
    buildOmoArgs('Explain this image', {
      sessionId: '019ff9fa-abab-78a3-83b0-67c261374f42',
      model: 'anthropic/claude-opus-5',
      effort: 'high',
      images: [{ path: '/tmp/shot.png' }, { path: '   ' }, { path: 42 }],
    }),
    [
      '--mode', 'json', '--print',
      '--session-id', '019ff9fa-abab-78a3-83b0-67c261374f42',
      '--model', 'anthropic/claude-opus-5',
      '--thinking', 'high',
      '@/tmp/shot.png',
      'Explain this image',
    ],
  );
});

// omo's `--resume` takes no value and opens an interactive picker; under
// `--print` with no stdin it exits 13 without running the turn, so every
// follow-up message in a session failed. Oh My Pi's `--resume <id>` is the
// unrelated flag that happens to share the name.
test('omo and Oh My Pi do not share a session flag', () => {
  const omo = buildOmoArgs('hi', { sessionId: 'S' });
  const omp = buildOmpArgs('hi', { sessionId: 'S' });

  assert.ok(omo.includes('--session-id'), 'omo must use --session-id');
  assert.ok(!omo.includes('--resume'), 'omo must never receive --resume');
  assert.ok(omp.includes('--resume'), 'Oh My Pi keeps --resume');
  assert.ok(!omp.includes('--session-id'));
});

test('buildOmoArgs omits placeholder model and effort selections', () => {
  assert.deepEqual(
    buildOmoArgs('hi', { model: 'default', effort: 'default' }),
    ['--mode', 'json', '--print', 'hi'],
  );
});

// Event shapes below are verbatim from `omo --mode json --print`.
test('normalizeOmoEvent captures the native session id and streams assistant text', () => {
  assert.deepEqual(
    normalizeOmoEvent(
      { type: 'session', version: 3, id: '019ff9fa-abab-78a3-83b0-67c261374f42', cwd: '/tmp' },
      null,
    ).providerSessionId,
    '019ff9fa-abab-78a3-83b0-67c261374f42',
  );

  const streamed = normalizeOmoEvent({
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'ok' },
  }, 'session-1');
  assert.equal(streamed.messages.length, 1);
  assert.equal(streamed.messages[0].kind, 'stream_delta');
  assert.equal(streamed.messages[0].content, 'ok');
  assert.equal(streamed.messages[0].provider, 'omo');
});

test('normalizeOmoEvent maps the native tool lifecycle to shared tool messages', () => {
  const started = normalizeOmoEvent({
    type: 'tool_execution_start',
    toolCallId: 'toolu_01FqdHoP72XmbXtPo5yrEdkM',
    toolName: 'read',
    args: { path: '/tmp/omo-json-probe/sample.txt' },
  }, 'session-1');
  assert.equal(started.messages[0].kind, 'tool_use');
  assert.equal(started.messages[0].toolName, 'read');
  assert.equal(started.messages[0].toolId, 'toolu_01FqdHoP72XmbXtPo5yrEdkM');
  assert.deepEqual(started.messages[0].toolInput, { path: '/tmp/omo-json-probe/sample.txt' });

  const ended = normalizeOmoEvent({
    type: 'tool_execution_end',
    toolCallId: 'toolu_01FqdHoP72XmbXtPo5yrEdkM',
    toolName: 'read',
    result: { content: [{ type: 'text', text: 'probe file\n' }] },
    isError: false,
  }, 'session-1');
  assert.equal(ended.messages[0].kind, 'tool_result');
  assert.equal(ended.messages[0].toolId, 'toolu_01FqdHoP72XmbXtPo5yrEdkM');
  assert.equal(ended.messages[0].content, 'probe file\n');
  assert.equal(ended.messages[0].isError, false);
});

test('normalizeOmoEvent ignores the non-message envelopes the CLI also emits', () => {
  for (const event of [
    { type: 'agent_start' },
    { type: 'turn_start' },
    { type: 'turn_end', message: { role: 'assistant', content: [] } },
    { type: 'agent_settled' },
    { type: 'entry_appended', entry: { type: 'custom', customType: 'omo-memory:accepted-turns' } },
    { type: 'tool_hook_status', hookName: 'PreToolUse', toolName: 'read' },
    { type: 'message_update', assistantMessageEvent: { type: 'text_start', contentIndex: 0 } },
  ]) {
    assert.deepEqual(normalizeOmoEvent(event, 'session-1').messages, [], event.type);
  }
});

test('normalizeOmoEvent surfaces errors with an omo-labelled fallback', () => {
  assert.equal(
    normalizeOmoEvent({ type: 'error', error: { message: 'boom' } }, 'session-1').messages[0].content,
    'boom',
  );
  assert.equal(
    normalizeOmoEvent({ type: 'error' }, 'session-1').messages[0].content,
    'omo failed.',
  );
});
