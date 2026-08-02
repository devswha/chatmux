import test from 'node:test';
import assert from 'node:assert/strict';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { QuestionAnswerContent } from './QuestionAnswerContent';

// Regression coverage for the chat-interface crash where an AskUserQuestion
// payload loaded from a session transcript arrives with a non-array `questions`
// or a question missing its `options` array. Rendering must degrade gracefully
// instead of throwing "TypeError: e.map is not a function".

test('renders without throwing when questions is a non-array value', () => {
  assert.doesNotThrow(() => {
    renderToStaticMarkup(
      React.createElement(QuestionAnswerContent, {
        // Malformed: object instead of an array
        questions: { 0: { question: 'q?', options: [{ label: 'a' }] } } as never,
        answers: {},
      }),
    );
  });
});

test('renders without throwing when a question is missing options[]', () => {
  assert.doesNotThrow(() => {
    renderToStaticMarkup(
      React.createElement(QuestionAnswerContent, {
        questions: [{ question: 'Pick one?', header: 'H' } as never],
        answers: { 'Pick one?': 'X' },
      }),
    );
  });
});

test('renders without throwing when options[] contains malformed entries', () => {
  assert.doesNotThrow(() => {
    renderToStaticMarkup(
      React.createElement(QuestionAnswerContent, {
        questions: [{ question: 'Pick one?', options: [null, 'oops', { label: 'A' }] } as never],
        answers: { 'Pick one?': 'A, Custom' },
      }),
    );
  });
});

test('renders without throwing when a questions entry is null/non-object', () => {
  assert.doesNotThrow(() => {
    renderToStaticMarkup(
      React.createElement(QuestionAnswerContent, {
        questions: [null, 'oops', { question: 'Ok?', options: [{ label: 'A' }] }] as never,
        answers: {},
      }),
    );
  });
});

test('renders without throwing when an answer is a non-string value', () => {
  assert.doesNotThrow(() => {
    renderToStaticMarkup(
      React.createElement(QuestionAnswerContent, {
        questions: [{ question: 'Pick one?', options: [{ label: 'A' }] }],
        // Malformed: answer is an object instead of the expected string
        answers: { 'Pick one?': { unexpected: true } } as never,
      }),
    );
  });
});

test('still renders a well-formed question + answer', () => {
  const html = renderToStaticMarkup(
    React.createElement(QuestionAnswerContent, {
      questions: [{ question: 'Pick one?', header: 'H', options: [{ label: 'A' }, { label: 'B' }] }],
      answers: { 'Pick one?': 'A' },
    }),
  );
  assert.ok(html.includes('Pick one?'));
});

test('pending transcript question renders numbered choices, direct input, and cancel guidance', () => {
  const html = renderToStaticMarkup(
    React.createElement(QuestionAnswerContent, {
      questions: [{ question: 'Pick one?', options: [{ label: 'Allow' }, { label: 'Reject' }] }],
      answers: {},
      pending: true,
    }),
  );
  assert.ok(html.includes('1.'));
  assert.ok(html.includes('2.'));
  assert.ok(html.includes('3.'));
  assert.ok(html.includes('Direct input'));
  assert.ok(html.includes('0: cancel'));
  assert.ok(!html.includes('Skipped'));
});

test('pending single-select choices become buttons only when a choice handler is provided', () => {
  const withHandler = renderToStaticMarkup(
    React.createElement(QuestionAnswerContent, {
      questions: [{ question: 'Pick one?', options: [{ label: 'Allow' }, { label: 'Reject' }] }],
      answers: {},
      pending: true,
      onSelectChoice: () => {},
    }),
  );
  // Option rows, the direct-input row, and the cancel affordance are all tappable.
  assert.ok((withHandler.match(/<button type="button"/g) ?? []).length >= 4);
  assert.ok(withHandler.includes('Cancel (0)'));

  const withoutHandler = renderToStaticMarkup(
    React.createElement(QuestionAnswerContent, {
      questions: [{ question: 'Pick one?', options: [{ label: 'Allow' }, { label: 'Reject' }] }],
      answers: {},
      pending: true,
    }),
  );
  assert.ok(!withoutHandler.includes('Cancel (0)'));

  const multiSelect = renderToStaticMarkup(
    React.createElement(QuestionAnswerContent, {
      questions: [{ question: 'Pick many?', options: [{ label: 'A' }, { label: 'B' }], multiSelect: true }],
      answers: {},
      pending: true,
      onSelectChoice: () => {},
    }),
  );
  // Multi-select stays typed: no tappable option rows, no cancel button.
  assert.ok(!multiSelect.includes('Cancel (0)'));
});

test('a provider-native custom option does not add a second direct-input row', () => {
  const html = renderToStaticMarkup(
    React.createElement(QuestionAnswerContent, {
      questions: [{
        question: 'Ready to code?',
        options: [
          { label: 'Approve' },
          { label: 'Tell Claude what to change' },
        ],
      }],
      answers: {},
      pending: true,
      allowDirectInput: true,
      directInputNumber: 2,
    }),
  );
  assert.ok(html.includes('2.'));
  assert.ok(!html.includes('Direct input (Other)'));
});
