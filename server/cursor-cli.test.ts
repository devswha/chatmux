import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildCursorArgs } from './cursor-cli.js';

test('a read-only Cursor mode never carries the force flag, even when skip-permissions is on', () => {
  const args = buildCursorArgs({
    sessionId: undefined,
    command: 'write a commit message',
    images: undefined,
    resolvedModel: undefined,
    mode: 'ask',
    skipPermissions: true,
  });
  assert.deepEqual(args, ['-p', 'write a commit message', '--output-format', 'stream-json', '--mode', 'ask']);
  assert.equal(args.includes('-f'), false);
});

test('interactive Cursor runs keep resume, model and the operator-chosen force flag', () => {
  assert.deepEqual(buildCursorArgs({
    sessionId: 'chat-1',
    command: 'continue',
    images: undefined,
    resolvedModel: 'gpt-5',
    mode: undefined,
    skipPermissions: true,
  }), ['--resume=chat-1', '-p', 'continue', '--model', 'gpt-5', '--output-format', 'stream-json', '-f']);
  assert.deepEqual(buildCursorArgs({
    sessionId: undefined,
    command: 'hello',
    images: undefined,
    resolvedModel: undefined,
    mode: undefined,
    skipPermissions: false,
  }), ['-p', 'hello', '--output-format', 'stream-json']);
  assert.deepEqual(buildCursorArgs({
    sessionId: undefined,
    command: 'hello',
    images: undefined,
    resolvedModel: undefined,
    mode: 'yolo',
    skipPermissions: false,
  }), ['-p', 'hello', '--output-format', 'stream-json'], 'unknown modes are ignored rather than forwarded');
});
