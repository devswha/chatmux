import assert from 'node:assert/strict';
import test from 'node:test';

import { routeRelayAnswer, type RelayAnswerContext } from './relayAnswer';

const prompt = { optionCount: 3, customOptionNumber: 4, multiSelect: false };
const multiPrompt = { optionCount: 3, customOptionNumber: null, multiSelect: true };
const base: RelayAnswerContext = {
  message: '',
  prompt: null,
  awaitingPromptCustom: false,
  ask: null,
  awaitingAskCustom: false,
};

test('Given no question on screen, when a message is answered, then it is plain relayed text', () => {
  // Given / When / Then
  assert.deepEqual(routeRelayAnswer({ ...base, message: 'hello there' }), { kind: 'text' });
});

test('Given both a pane prompt and a transcript ask, when a number is typed, then the ask card owns the answer', () => {
  // Given
  const context = { ...base, message: '2', prompt, ask: { maxChoiceNumber: 2 } };

  // When
  const route = routeRelayAnswer(context);

  // Then
  assert.deepEqual(route, { kind: 'ask-choice', choiceIndex: 1 });
});

test('Given a pane prompt started a custom answer, when both are on screen, then the prompt keeps the continuation', () => {
  // Given / When
  const route = routeRelayAnswer({
    ...base, message: 'my own answer', prompt, ask: { maxChoiceNumber: 2 }, awaitingPromptCustom: true,
  });

  // Then
  assert.deepEqual(route, { kind: 'interactive-custom' });
});

test('Given a single-select pane prompt, when several numbers are typed, then the answer is refused', () => {
  // Given / When
  const route = routeRelayAnswer({ ...base, message: '1,2', prompt });

  // Then
  assert.deepEqual(route, { kind: 'invalid', max: 4, multiSelect: false });
});

test('Given a multi-select pane prompt, when distinct in-range numbers are typed, then all choices are kept', () => {
  // Given / When
  const route = routeRelayAnswer({ ...base, message: '1, 3', prompt: multiPrompt });

  // Then
  assert.deepEqual(route, { kind: 'interactive-choices', choices: [1, 3] });
});

test('Given a multi-select pane prompt, when cancel is mixed with a choice or a number repeats, then the answer is refused', () => {
  // Given / When / Then
  assert.deepEqual(routeRelayAnswer({ ...base, message: '0,1', prompt: multiPrompt }), { kind: 'invalid', max: 3, multiSelect: true });
  assert.deepEqual(routeRelayAnswer({ ...base, message: '2,2', prompt: multiPrompt }), { kind: 'invalid', max: 3, multiSelect: true });
  assert.deepEqual(routeRelayAnswer({ ...base, message: '4', prompt: multiPrompt }), { kind: 'invalid', max: 3, multiSelect: true });
});

test('Given a pane prompt with a custom option, when that number is typed, then it is a valid choice', () => {
  // Given / When
  const route = routeRelayAnswer({ ...base, message: '4', prompt });

  // Then
  assert.deepEqual(route, { kind: 'interactive-choices', choices: [4] });
});

test('Given a transcript ask, when cancel is chosen, then it maps to the cancel index rather than an option', () => {
  // Given / When
  const route = routeRelayAnswer({ ...base, message: '0', ask: { maxChoiceNumber: 3 } });

  // Then
  assert.deepEqual(route, { kind: 'ask-choice', choiceIndex: -1 });
});

test('Given a transcript ask, when the answer is not a number or out of range, then it is refused', () => {
  // Given / When / Then
  assert.deepEqual(routeRelayAnswer({ ...base, message: 'maybe', ask: { maxChoiceNumber: 3 } }), { kind: 'invalid', max: 3, multiSelect: false });
  assert.deepEqual(routeRelayAnswer({ ...base, message: '9', ask: { maxChoiceNumber: 3 } }), { kind: 'invalid', max: 3, multiSelect: false });
});

test('Given a transcript ask awaiting its custom answer, when text is typed, then it is the ask custom route', () => {
  // Given / When
  const route = routeRelayAnswer({ ...base, message: 'free text', ask: { maxChoiceNumber: 3 }, awaitingAskCustom: true });

  // Then
  assert.deepEqual(route, { kind: 'ask-custom' });
});
