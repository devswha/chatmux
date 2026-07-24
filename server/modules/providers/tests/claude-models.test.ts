import assert from 'node:assert/strict';
import test from 'node:test';

import { parseClaudeActiveModelLine } from '@/modules/providers/list/claude/claude-models.provider.js';

const sessionId = '92869134-b4df-453e-b3a6-ed1d750d69d9';

test('Claude transcript active model includes its reasoning effort', () => {
  const line = JSON.stringify({
    type: 'assistant',
    sessionId,
    effort: 'xhigh',
    message: {
      model: 'claude-fable-5',
      role: 'assistant',
    },
  });

  assert.deepEqual(parseClaudeActiveModelLine(line, sessionId), {
    model: 'claude-fable-5',
    effort: 'xhigh',
  });
});

test('Claude transcript active model rejects another session and malformed JSON', () => {
  assert.equal(parseClaudeActiveModelLine(JSON.stringify({
    sessionId: 'another-session',
    effort: 'high',
    message: { model: 'claude-opus-4-8' },
  }), sessionId), null);
  assert.equal(parseClaudeActiveModelLine('{', sessionId), null);
});
