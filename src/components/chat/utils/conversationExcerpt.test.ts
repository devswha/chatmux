import assert from 'node:assert/strict';
import test from 'node:test';

import type { ChatMessage } from '../types/types';

import { buildConversationExcerpt, excerptCandidates, EXCERPT_CHARACTER_LIMIT, EXCERPT_MESSAGE_LIMIT } from './conversationExcerpt';

const labels = { title: 'Selected conversation excerpt', user: 'User', assistant: 'Assistant' };
const message = (content: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  type: 'assistant', content, timestamp: '2026-09-05T00:00:00Z', ...extra,
});

test('only explicit user/assistant conversation text is offered without hidden metadata', () => {
  const candidates = excerptCandidates([
    message('visible answer', { toolResult: { content: 'private tool output' }, transcriptPath: '/private/transcript', attachCapability: 'private-token' }),
    message('visible question', { type: 'user', images: [{ path: '/private/image' }] }),
    message('hidden thought', { isThinking: true }),
    message('tool contents', { isToolUse: true }),
    message('error details', { type: 'error' }),
    message('notification', { isTaskNotification: true }),
    message('   '),
  ]);
  assert.deepEqual(candidates.map(({ text }) => text), ['visible answer', 'visible question']);
  const output = buildConversationExcerpt(candidates, new Set([1]), labels);
  assert.match(output!, /visible question/);
  assert.doesNotMatch(output!, /visible answer|private|hidden|tool contents|notification/);
  assert.equal(buildConversationExcerpt(candidates, new Set(), labels), null);
});

test('selection preserves conversation order and captured text rather than later streaming changes', () => {
  const source = [message('first'), message('second')];
  const candidates = excerptCandidates(source);
  source[0].content = 'new streaming content';
  const output = buildConversationExcerpt(candidates, new Set([1, 0]), labels)!;
  assert.ok(output.indexOf('first') < output.indexOf('second'));
  assert.doesNotMatch(output, /new streaming content/);
  assert.match(output, /2026-09-05T00:00:00.000Z/);
});

test('large selections fail without silently truncating copied text; other choices remain usable', () => {
  const candidates = excerptCandidates([message('x'.repeat(EXCERPT_CHARACTER_LIMIT)), message('short')]);
  assert.equal(buildConversationExcerpt(candidates, new Set([0, 1]), labels), null);
  assert.match(buildConversationExcerpt(candidates, new Set([1]), labels)!, /short$/);
});

test('candidate bound keeps the newest eligible messages and invalid dates do not leak raw values', () => {
  const candidates = excerptCandidates(Array.from({ length: EXCERPT_MESSAGE_LIMIT + 5 }, (_, index) => message(String(index), { timestamp: 'bad-private-value' })));
  assert.equal(candidates.length, EXCERPT_MESSAGE_LIMIT);
  assert.equal(candidates[0].text, '5');
  assert.equal(candidates[0].timestamp, null);
  assert.doesNotMatch(buildConversationExcerpt(candidates, new Set([5]), labels)!, /bad-private-value|Invalid Date/);
});
