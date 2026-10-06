import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import type { TmuxRunner } from '@/modules/providers/services/builtin-relay.service.js';
import { parseClaudeAskSelectionScreen } from '@/modules/providers/services/tmux-ask-selection.service.js';
import { createVerifiedTmuxActionTarget } from '@/modules/providers/services/tmux-fresh-verifier.service.js';
import {
  getTmuxInteractivePrompt,
  parseTmuxInteractivePrompt,
} from '@/modules/providers/services/tmux-interactive-prompt.service.js';

// A numbered list in the assistant's reply, above a short Claude question, must
// not hide the question. Fixtures are real Claude Code TUI captures in a 78x73
// tmux pane (`capture-pane -p -e -N -S -80`, and the visible screen alone):
// - `s1`: fullscreen renderer, a 40-item list right above the question frame;
// - `s2`: default renderer, the same shape;
// - `list40`: default renderer, re-captured with colour;
// - `list3`: default renderer, an earlier 40-item list in scrollback and a
//   3-item list numbered 1.-3. directly above the frame.
const FIXTURE_DIR = new URL('./fixtures/claude-question-numbered-list/', import.meta.url);
const read = (name: string) => readFileSync(new URL(name, FIXTURE_DIR), 'utf8');
type Shot = { joined: string; screen: string };
const shot = (name: string, ext: 'txt' | 'ansi'): Shot => ({
  joined: read(`${name}.joined.${ext}`),
  screen: read(`${name}.screen.${ext}`),
});
const ANSI_RE = /\u001b\[[0-?]*[ -/]*[@-~]/g;

let generation = 0;
const targetFor = () => createVerifiedTmuxActionTarget(
  { socketPath: '/tmp/chatmux-numbered-list-test.sock', sessionId: '$7', windowId: '@8', paneId: '%9' },
  { pid: 42, startedAtMs: (generation += 1) },
  'claude', 'test', 'claude-session',
);

/** A pane whose `capture-pane` returns the given text, trimmed as runTmux trims. */
function paneOf(text: string): TmuxRunner {
  return async (args) => {
    if (args.includes('capture-pane')) return { code: 0, output: text.trim() };
    if (args.includes('display-message')) return { code: 0, output: '$7\t@8\t%9\n' };
    return { code: 0, output: '' };
  };
}

/** Numbered lines above the frame's header chip: the list that used to hide the card. */
function numberedAboveFrame(text: string): number {
  const lines = text.replace(ANSI_RE, '').split('\n');
  const top = lines.findIndex((line) => /^\s*☐\s+\S/.test(line));
  assert.ok(top > 0, 'fixture assumption broken: no header chip');
  return lines.slice(0, top).filter((line) => /^\s*(?:●\s*)?\d+\.\s/.test(line)).length;
}

const PACK = 'Pack the green fig and golden-yellow peaches together?';
const SHORT_ASKS = [
  ['s1-78x73', 'txt', PACK, ['Ripe avocados', 'Big red plum']],
  ['s2-78x73', 'txt', PACK, ['Ripe avocados', 'Big red plum']],
  ['list40-78x73', 'ansi', PACK, ['Ripe avocados', 'Big red plum']],
  ['list3-78x73', 'ansi', 'Which step goes first?', ['Apple', 'Banana', 'Cherry']],
] as const;

for (const [name, ext, question, labels] of SHORT_ASKS) {
  test(`${name}: a short Claude question under a numbered list still gets its card`, async () => {
    const { joined, screen } = shot(name, ext);
    assert.ok(numberedAboveFrame(joined) >= 2, 'fixture assumption broken: no list above the frame');
    for (const [capture, prompt] of [
      ['joined', await getTmuxInteractivePrompt(targetFor(), paneOf(joined))],
      ['screen', parseTmuxInteractivePrompt('claude', screen)],
    ] as const) {
      assert.ok(prompt, `${capture}: the card reads the question`);
      assert.equal(prompt.kind, 'question');
      assert.equal(prompt.question, question);
      assert.deepEqual(prompt.options.map((option) => option.label), [...labels]);
      assert.equal(prompt.multiSelect, false);
      assert.equal(prompt.customOptionNumber, labels.length + 1);
    }
  });
}

/** s2's question frame, under a list numbered 1.-3. whose items repeat the frame's own rows. */
function listDirectlyAbove(keepDivider: boolean): string {
  const lines = read('s2-78x73.joined.txt').split('\n');
  const chip = lines.findIndex((line) => line.includes('☐ Pick one'));
  assert.ok(chip > 0, 'fixture assumption broken: no header chip');
  const frameLines = lines.slice(keepDivider ? chip - 1 : chip);
  return [
    '● Here is the plan:',
    '',
    '  1. Ripe avocados',
    '  2. Big red plum',
    '  3. Type something.',
    ...frameLines,
  ].join('\n');
}

test('a list numbered 1.-3. directly above the frame yields the real options only', () => {
  for (const keepDivider of [true, false]) {
    const text = listDirectlyAbove(keepDivider);
    assert.equal((text.match(/^[ ❯] 1\. /gm) ?? []).length, 2, 'fixture assumption broken: two runs start at 1.');
    const prompt = parseTmuxInteractivePrompt('claude', text);
    assert.ok(prompt, `divider ${keepDivider}: the card reads the question`);
    assert.equal(prompt.question, PACK);
    assert.deepEqual(prompt.options.map((option) => option.label), ['Ripe avocados', 'Big red plum']);
    assert.equal(prompt.customOptionNumber, 3);
  }
});

test('control: a short Claude question with no list above parses as before', () => {
  const text = listDirectlyAbove(true).split('\n').slice(5).join('\n');
  assert.equal(numberedAboveFrame(text), 0, 'fixture assumption broken: a list is still above the frame');
  const prompt = parseTmuxInteractivePrompt('claude', text);
  assert.ok(prompt);
  assert.equal(prompt.question, PACK);
  assert.deepEqual(prompt.options.map((option) => option.label), ['Ripe avocados', 'Big red plum']);
  assert.deepEqual(prompt.options.map((option) => option.description), ['Soft green, very ripe', 'Deep red skin']);
  assert.equal(prompt.customOptionNumber, 3);
});

// The transcript-ask path matches screen rows against the transcript's own
// labels, in a window that must number 1..N and end in "Type something." and
// "Chat about this". A list above the frame cannot complete such a window, so
// it already finds the real rows; these cases pin that.
test('transcript asks: a numbered list above the frame never hides or replaces the real rows', () => {
  const question = { question: PACK, options: [{ label: 'Ripe avocados' }, { label: 'Big red plum' }] };
  const fruit = { question: 'Which step goes first?', options: [{ label: 'Apple' }, { label: 'Banana' }, { label: 'Cherry' }] };
  const screens = [
    [shot('s1-78x73', 'txt').joined, question],
    [shot('s2-78x73', 'txt').joined, question],
    [shot('list40-78x73', 'ansi').joined, question],
    [shot('list3-78x73', 'ansi').joined, fruit],
    [listDirectlyAbove(true), question],
    [listDirectlyAbove(false), question],
  ] as const;
  for (const [screen, ask] of screens) {
    const last = ask.options.length - 1;
    // Every capture has row 1 focused, so moving to the last option is `last` steps down.
    assert.deepEqual(parseClaudeAskSelectionScreen(screen, ask, last), {
      action: 'option',
      delta: last,
      label: ask.options[last].label,
    });
    assert.deepEqual(parseClaudeAskSelectionScreen(screen, ask, ask.options.length), {
      action: 'other',
      delta: ask.options.length,
      label: 'Direct input',
    });
  }
});
