import assert from 'node:assert/strict';
import test from 'node:test';

import type { ChatMessage } from '../types/types';

import { findPendingRelayAsk, findUnansweredRelayAskToolId } from './pendingRelayAsk';

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

test('findPendingRelayAsk rejects multi-question asks so the screen-derived prompt stays active', () => {
  assert.equal(findPendingRelayAsk([{
    ...pending,
    toolInput: {
      questions: [
        { question: 'Format?', options: [{ label: 'ONNX' }, { label: 'TensorRT' }] },
        { question: 'Precision?', options: [{ label: 'FP16' }, { label: 'INT8' }] },
      ],
    },
  }]), null);
});

test('findUnansweredRelayAskToolId tracks multi-question asks without making them transcript-actionable', () => {
  const multiQuestion = {
    ...pending,
    toolId: 'ask-multi',
    toolInput: {
      questions: [
        { question: 'Format?', options: [{ label: 'ONNX' }, { label: 'TensorRT' }] },
        { question: 'Precision?', options: [{ label: 'FP16' }, { label: 'INT8' }] },
      ],
    },
  };
  assert.equal(findUnansweredRelayAskToolId([multiQuestion]), 'ask-multi');
  assert.equal(findPendingRelayAsk([multiQuestion]), null);
  assert.equal(
    findUnansweredRelayAskToolId([{ ...multiQuestion, toolResult: { content: 'done' } }]),
    null,
  );
});
