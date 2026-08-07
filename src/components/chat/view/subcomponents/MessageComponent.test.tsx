import assert from 'node:assert/strict';
import test from 'node:test';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import '../../../../i18n/config';
import type { ChatMessage } from '../../types/types';

import MessageComponent from './MessageComponent';

const renderMessage = (
  message: ChatMessage,
  suppressedAskToolId: string | null = null,
): string => renderToStaticMarkup(createElement(MessageComponent, {
  message,
  prevMessage: null,
  createDiff: () => [],
  provider: 'claude',
  suppressedAskToolId,
}));

test('standalone conversation errors keep details collapsed and omit the redundant provider header', () => {
  const html = renderMessage({
    type: 'error',
    content: 'Request failed\nInternal stack line',
    timestamp: '2026-07-29T12:00:00.000Z',
  });

  assert.match(html, /<details(?![^>]*\sopen(?:=|\s|>))[^>]*>/);
  assert.match(html, /<summary[^>]*>[\s\S]*Request failed[\s\S]*<\/summary>/);
  assert.match(html, /Internal stack line/);
  assert.equal((html.match(/>Error</g) || []).length, 1);
});

test('non-Bash tool failures expose full output only through a collapsed disclosure', () => {
  const html = renderMessage({
    type: 'assistant',
    content: '',
    timestamp: '2026-07-29T12:00:00.000Z',
    isToolUse: true,
    toolName: 'Read',
    toolInput: JSON.stringify({ path: '/missing' }),
    toolId: 'tool-1',
    toolResult: {
      content: 'File was not found\nInternal lookup detail',
      isError: true,
    },
  });

  assert.match(html, /<details[^>]*id="tool-result-tool-1"(?![^>]*\sopen(?:=|\s|>))[^>]*>/);
  assert.match(html, /Read Error/);
  assert.match(html, /Internal lookup detail/);
});

test('screen-driven multi-question asks hide the inert transcript duplicate', () => {
  const message: ChatMessage = {
    type: 'assistant',
    content: '',
    timestamp: '2026-08-08T00:00:00.000Z',
    isToolUse: true,
    toolName: 'AskUserQuestion',
    toolId: 'ask-multi',
    toolInput: {
      questions: [
        { question: 'First?', options: [{ label: 'A' }, { label: 'B' }] },
        { question: 'Second?', options: [{ label: 'C' }, { label: 'D' }], multiSelect: true },
      ],
    },
  };

  assert.match(renderMessage(message), /Second\?/);
  assert.doesNotMatch(renderMessage(message, 'ask-multi'), /Second\?/);
});
