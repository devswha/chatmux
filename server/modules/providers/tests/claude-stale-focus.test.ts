import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import type { TmuxRunner } from '@/modules/providers/services/builtin-relay.service.js';
import { answerPendingTmuxAskSelection } from '@/modules/providers/services/tmux-ask-selection.service.js';
import { createVerifiedTmuxActionTarget } from '@/modules/providers/services/tmux-fresh-verifier.service.js';
import {
  answerTmuxInteractivePrompt,
  getTmuxInteractivePrompt,
  parseTmuxInteractivePrompt,
} from '@/modules/providers/services/tmux-interactive-prompt.service.js';

// Captured from Claude Code 2.1.289 with its DEFAULT renderer in a private tmux
// server, 64x31 (F1: 78x38). `<n>.joined.ansi` is the server's own capture
// (capture-pane -p -e -N -S -80); `<n>.screen.txt` is the visible screen alone
// at the same moment. On the tall asks the focus marker `❯` stays drawn on
// option 1 in scrollback after the focus moved: answering from it delivered
// Banana for Apple (C4, F1), Cherry for Banana (C6), Cherry for Apple (C7).
const FIXTURE_DIR = new URL('./fixtures/claude-stale-focus/', import.meta.url);
const read = (name: string) => readFileSync(new URL(name, FIXTURE_DIR), 'utf8');
type Frame = { joined: string; screen: string };
const frame = (name: string): Frame => ({ joined: read(`${name}.joined.ansi`), screen: read(`${name}.screen.txt`) });
const visibleFrom = (shot: Frame) => shot.joined.split('\n').length - shot.screen.split('\n').length;
const ANSI_RE = /\u001b\[[0-?]*[ -/]*[@-~]/g;

const FRUIT = {
  question: 'Which fruit do you want?',
  options: [{ label: 'Apple' }, { label: 'Banana' }, { label: 'Cherry' }, { label: 'Date' }],
};
const pendingAsk = { toolId: 'toolu_fruit', questions: [FRUIT] };

let generation = 0;
function targetFor() {
  return createVerifiedTmuxActionTarget(
    { socketPath: '/tmp/chatmux-stale-focus-test.sock', sessionId: '$7', windowId: '@8', paneId: '%9' },
    { pid: 42, startedAtMs: (generation += 1) },
    'claude', 'test', 'claude-session',
  );
}

/**
 * A pane that answers the joined capture (`-S -80`) and the screen-only capture
 * from `state.shot`; `onKey` lets a test move the TUI. Outputs are trimmed
 * exactly as runTmux trims them, which drops the screen's leading blank rows
 * and the indent of its first line.
 */
function pane(state: { shot: Frame }, hooks: { onKey?: (key: string) => void } = {}) {
  const keys: string[] = [];
  const run: TmuxRunner = async (args) => {
    if (args.includes('send-keys')) {
      keys.push(String(args.at(-1)));
      hooks.onKey?.(String(args.at(-1)));
      return { code: 0, output: '' };
    }
    if (args.includes('capture-pane')) {
      return { code: 0, output: (args.includes('-80') ? state.shot.joined : state.shot.screen).trim() };
    }
    if (args.includes('display-message')) return { code: 0, output: '$7\t@8\t%9\n' };
    return { code: 0, output: '' };
  };
  return { run, keys };
}

const fast = () => {
  let clock = 0;
  return { sleep: async (ms: number) => { clock += ms; }, now: () => clock };
};

/** Moves the `❯` of a numbered list to option `n` (plain text, every line). */
function focusOn(text: string, n: number): string {
  return text.replace(ANSI_RE, '').split('\n').map((line) => {
    const match = line.match(/^[❯ ] (\d+)\. /);
    if (!match) return line;
    return `${Number(match[1]) === n ? '❯' : ' '}${line.slice(1)}`;
  }).join('\n');
}
const focusFrame = (shot: Frame, n: number): Frame => ({ joined: focusOn(shot.joined, n), screen: focusOn(shot.screen, n) });

/** A focus that moves with the arrow keys, as the TUI's does. */
function followKeys(state: { shot: Frame }, shot: Frame, from: number) {
  let focus = from;
  return {
    onKey: (key: string) => {
      if (key === 'Down') focus += 1;
      if (key === 'Up') focus -= 1;
      state.shot = focusFrame(shot, focus);
    },
    focus: () => focus,
  };
}

const TALL = [['C4.1', 1], ['C6.1', 2], ['C7.1', 1], ['F1.1', 1]] as const;
const SHORT = [
  ['E1.1', 2, 3, ['Down', 'Enter']],
  ['E2.1', 4, 1, ['Up', 'Up', 'Up', 'Enter']],
] as const;

// ---- prompt card -----------------------------------------------------------

for (const [name, choice] of TALL) {
  test(`card, ${name}: a tall ask whose only marker is in scrollback is refused, never answered`, async () => {
    const shot = frame(name);
    const legacy = parseTmuxInteractivePrompt('claude', shot.joined);
    assert.ok(legacy, `${name}: fixture assumption broken, the joined capture no longer parses`);
    const { run, keys } = pane({ shot });
    assert.equal(await getTmuxInteractivePrompt(targetFor(), run), null, `${name}: no answerable card`);
    await assert.rejects(
      answerTmuxInteractivePrompt(targetFor(), legacy.id, [choice], run, fast()),
      (error: { code?: string; statusCode?: number }) => error.code === 'TMUX_INTERACTIVE_PROMPT_STALE' && error.statusCode === 409,
    );
    assert.deepEqual(keys, [], `${name}: nothing is sent`);
  });
}

for (const [name, from, choice, expected] of SHORT) {
  test(`card, ${name}: a short ask keeps its card and its keys`, async () => {
    const shot = frame(name);
    const legacy = parseTmuxInteractivePrompt('claude', shot.joined);
    assert.ok(legacy);
    assert.equal(legacy.selectedIndex, from - 1, 'fixture assumption broken: focus moved');
    const state = { shot };
    const tui = followKeys(state, shot, from);
    const { run, keys } = pane(state, { onKey: tui.onKey });
    const card = await getTmuxInteractivePrompt(targetFor(), run);
    assert.ok(card);
    assert.equal(card.id, legacy.id);
    assert.deepEqual(card.options, legacy.options);
    assert.deepEqual(await answerTmuxInteractivePrompt(targetFor(), legacy.id, [choice], run, fast()), { action: 'selected' });
    assert.deepEqual(keys, expected);
    assert.equal(tui.focus(), choice, 'the Enter landed on the chosen option');
  });
}

test('card: a frame with a stale mark in scrollback and a live one on screen is refused', async () => {
  const shot = frame('C1.1');
  assert.equal((shot.joined.replace(ANSI_RE, '').match(/^❯ \d+\./gm) ?? []).length, 2, 'fixture assumption broken');
  const { run, keys } = pane({ shot });
  assert.equal(await getTmuxInteractivePrompt(targetFor(), run), null);
  assert.deepEqual(keys, []);
});

test('card: if the focus does not land on the choice, the Enter is never sent', async () => {
  const shot = frame('E1.1');
  const legacy = parseTmuxInteractivePrompt('claude', shot.joined);
  assert.ok(legacy);
  for (const [lands, expected] of [[3, ['Down', 'Enter']], [4, ['Down']]] as const) {
    const state = { shot };
    const { run, keys } = pane(state, { onKey: (key) => { if (key === 'Down') state.shot = focusFrame(shot, lands); } });
    const answer = answerTmuxInteractivePrompt(targetFor(), legacy.id, [3], run, fast());
    if (lands === 3) assert.deepEqual(await answer, { action: 'selected' });
    else await assert.rejects(answer, (error: { code?: string; statusCode?: number }) => error.code === 'TMUX_INTERACTIVE_PROMPT_STALE' && error.statusCode === 409);
    assert.deepEqual(keys, expected, `focus landed on ${lands}`);
  }
});

// ---- transcript ask --------------------------------------------------------

const focusHidden = (error: { code?: string; statusCode?: number }) =>
  error.code === 'TMUX_ASK_FOCUS_HIDDEN' && error.statusCode === 409;

for (const [name, choice] of TALL) {
  test(`transcript ask, ${name}: a tall ask whose only marker is in scrollback is refused, never answered`, async () => {
    const shot = frame(name);
    assert.ok(visibleFrom(shot) > 0, `${name}: fixture assumption broken, the ask fits the screen`);
    const { run, keys } = pane({ shot });
    await assert.rejects(answerPendingTmuxAskSelection(targetFor(), pendingAsk, choice - 1, run, fast()), focusHidden);
    assert.deepEqual(keys, [], `${name}: nothing is sent`);
  });
}

for (const [name, from, choice, expected] of SHORT) {
  test(`transcript ask, ${name}: a short ask keeps its keys`, async () => {
    const shot = frame(name);
    const state = { shot };
    const tui = followKeys(state, shot, from);
    const { run, keys } = pane(state, { onKey: tui.onKey });
    assert.deepEqual(
      await answerPendingTmuxAskSelection(targetFor(), pendingAsk, choice - 1, run, fast()),
      { questionIndex: 0, action: 'option', label: FRUIT.options[choice - 1].label },
    );
    assert.deepEqual(keys, expected);
    assert.equal(tui.focus(), choice, 'the Enter landed on the chosen option');
  });
}

test('transcript ask: a frame with a stale mark in scrollback and a live one on screen is refused', async () => {
  const { run, keys } = pane({ shot: frame('C1.1') });
  await assert.rejects(answerPendingTmuxAskSelection(targetFor(), pendingAsk, 2, run, fast()), focusHidden);
  assert.deepEqual(keys, []);
});

test('transcript ask: if the focus does not land on the choice, the Enter is never sent', async () => {
  const shot = frame('E1.1');
  for (const [lands, expected] of [[3, ['Down', 'Enter']], [4, ['Down']]] as const) {
    const state = { shot };
    const { run, keys } = pane(state, { onKey: (key) => { if (key === 'Down') state.shot = focusFrame(shot, lands); } });
    const answer = answerPendingTmuxAskSelection(targetFor(), pendingAsk, 2, run, fast());
    if (lands === 3) assert.equal((await answer).label, 'Cherry');
    else await assert.rejects(answer, focusHidden);
    assert.deepEqual(keys, expected, `focus landed on ${lands}`);
  }
});
