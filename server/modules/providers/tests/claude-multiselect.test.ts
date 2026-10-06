import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import type { TmuxRunner } from '@/modules/providers/services/builtin-relay.service.js';
import { createVerifiedTmuxActionTarget } from '@/modules/providers/services/tmux-fresh-verifier.service.js';
import {
  answerTmuxInteractivePrompt,
  getTmuxInteractivePrompt,
  parseTmuxInteractivePrompt,
} from '@/modules/providers/services/tmux-interactive-prompt.service.js';

// Captured from Claude Code 2.1.291 (default renderer, 64x31) with
// `capture-pane -p -e -N -S -80`: a multiSelect AskUserQuestion with Apple,
// Banana, Cherry and Date, after Apple was ticked in the terminal. Claude Code
// draws a ticked option as `[✔]` (U+2714).
const pretick = readFileSync(new URL('./fixtures/claude-multiselect/pretick.joined.ansi', import.meta.url), 'utf8');
const TICKED = '[✔]';

const target = () => createVerifiedTmuxActionTarget(
  { socketPath: '/tmp/chatmux-multiselect-test.sock', sessionId: '$7', windowId: '@8', paneId: '%9' },
  { pid: 42, startedAtMs: 1234 },
  'claude',
  null,
);

function paneShowing(screen: string, keys: string[] = []): TmuxRunner {
  return async (args) => {
    if (args.includes('send-keys')) keys.push(String(args.at(-1)));
    if (args.includes('capture-pane')) return { code: 0, output: screen };
    if (args.includes('display-message')) return { code: 0, output: '$7\t@8\t%9\n' };
    return { code: 0, output: '' };
  };
}

/** Replays keys on the Claude multi-select: Up/Down move the focus, Enter toggles, Right leaves. */
function tickedAfter(keys: readonly string[], ticked: number[], focus = 1): number[] {
  const state = new Set(ticked);
  for (const key of keys) {
    if (key === 'Right') break;
    if (key === 'Down') focus += 1;
    if (key === 'Up') focus -= 1;
    if (key === 'Enter') {
      if (state.has(focus)) state.delete(focus);
      else state.add(focus);
    }
  }
  return [...state].sort();
}

test('a [✔] box from Claude Code reads as checked, with a clean label', async () => {
  assert.equal(pretick.split(TICKED).length, 2, 'fixture assumption broken: expected one [✔] row');
  const prompt = await getTmuxInteractivePrompt(target(), paneShowing(pretick));
  assert.ok(prompt);
  assert.equal(prompt.multiSelect, true);
  assert.deepEqual(prompt.checkedChoiceNumbers, [1]);
  assert.deepEqual(prompt.options.map((option) => option.label), ['Apple', 'Banana', 'Cherry', 'Date']);
});

test('answering Banana+Date with Apple ticked in the pane unticks Apple', async () => {
  const prompt = parseTmuxInteractivePrompt('claude', pretick);
  assert.ok(prompt);
  const keys: string[] = [];
  await answerTmuxInteractivePrompt(target(), prompt.id, [2, 4], paneShowing(pretick, keys));
  assert.deepEqual(keys, ['Enter', 'Down', 'Enter', 'Down', 'Down', 'Enter', 'Right', 'Enter']);
  assert.deepEqual(tickedAfter(keys, [1]), [2, 4], 'the submitted set is exactly Banana, Date');
});

test('[x], [X] and [✓] still read as checked on the same capture', () => {
  const ticked = parseTmuxInteractivePrompt('claude', pretick);
  assert.ok(ticked);
  for (const box of ['[x]', '[X]', '[✓]']) {
    const screen = pretick.replace(TICKED, box);
    assert.notEqual(screen, pretick, 'fixture assumption broken: the box was not replaced');
    const prompt = parseTmuxInteractivePrompt('claude', screen);
    assert.ok(prompt, box);
    assert.deepEqual(prompt.checkedOptionIndices, [0], box);
    assert.deepEqual(prompt.options.map((option) => option.label), ['Apple', 'Banana', 'Cherry', 'Date'], box);
    assert.equal(prompt.id, ticked.id, box);
  }
});

test('prompt id is stable when a box is ticked', () => {
  const unticked = pretick.replace(TICKED, '[ ]');
  assert.notEqual(unticked, pretick, 'fixture assumption broken: the box was not replaced');
  const before = parseTmuxInteractivePrompt('claude', unticked);
  const after = parseTmuxInteractivePrompt('claude', pretick);
  assert.ok(before && after);
  assert.deepEqual(before.checkedOptionIndices, []);
  assert.deepEqual(after.checkedOptionIndices, [0]);
  assert.equal(after.id, before.id);
});

test('every option ticked with [✔] is still a multi-select', () => {
  const allTicked = pretick.replace(/\[ \] (Banana|Cherry|Date)/g, `${TICKED} $1`);
  assert.equal(allTicked.split(TICKED).length, 5, 'fixture assumption broken: not all four rows ticked');
  const prompt = parseTmuxInteractivePrompt('claude', allTicked);
  assert.ok(prompt);
  assert.equal(prompt.multiSelect, true);
  assert.deepEqual(prompt.checkedOptionIndices, [0, 1, 2, 3]);
});
