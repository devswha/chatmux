import assert from 'node:assert/strict';
import test from 'node:test';

import type { ChatMessage } from '../types/types';

import { findPendingRelayAsk } from './pendingRelayAsk';

const pending: ChatMessage = {
  type: 'tool',
  timestamp: '2026-07-31T00:00:00.000Z',
  isToolUse: true,
  toolName: 'AskUserQuestion',
  toolId: 'ask-1',
  toolInput: {
    questions: [{
      question: 'Choose',
      options: [{ label: 'Allow' }, { label: 'Continue' }, { label: 'Reject' }],
    }],
  },
};

test('findPendingRelayAsk exposes the newest unanswered choice range', () => {
  assert.deepEqual(findPendingRelayAsk([pending]), {
    toolId: 'ask-1',
    maxChoiceNumber: 4,
  });
  assert.equal(findPendingRelayAsk([{ ...pending, toolResult: { content: 'done' } }]), null);
  assert.equal(findPendingRelayAsk([{
    ...pending,
    toolInput: {
      questions: [{
        question: 'Choose',
        options: [{ label: 'Allow' }],
        multiSelect: true,
      }],
    },
  }]), null);
});
