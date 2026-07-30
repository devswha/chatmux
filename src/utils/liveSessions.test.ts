import assert from 'node:assert/strict';
import test from 'node:test';

import type { TmuxPaneIdentity, TmuxProcessGeneration } from '../../shared/tmux';

import {
  findGjcPromotionCandidate,
  GJC_IDLE_SESSION_PREFIX,
  hasGjcTerminalTarget,
  isLiveTmuxActionable,
  isSameTmuxPaneTarget,
  readDiscoveryOk,
  readRestSessionContainer,
} from './liveSessions';


const tmux = (paneId: string): TmuxPaneIdentity => ({
  socketPath: '/tmp/chatmux.sock',
  sessionId: 'session-1',
  windowId: '@1',
  paneId,
});
const process = (pid: number): TmuxProcessGeneration => ({ pid, startedAtMs: 1_700_000_000_000 + pid });

const tmuxById: Record<string, TmuxPaneIdentity> = {
  '$6': tmux('%6'),
  '$7': tmux('%7'),
  '$8': tmux('%8'),
  '$9': tmux('%9'),
};
const processById: Record<string, TmuxProcessGeneration> = {
  '$6': process(6),
  '$7': process(7),
  '$8': process(8),
  '$9': process(9),
};

test('findGjcPromotionCandidate requires one structured row from the exact tmux generation', () => {
  const sessions = [
    { id: `${GJC_IDLE_SESSION_PREFIX}agent`, tmuxName: 'agent', tmux: tmuxById.$8, process: processById.$8 },
    { id: 'stale-session', tmuxName: 'agent', tmux: tmuxById.$7, process: processById.$7 },
    { id: 'current-session', tmuxName: 'agent', tmux: tmuxById.$8, process: processById.$8 },
  ];

  assert.deepEqual(
    findGjcPromotionCandidate(sessions, { tmuxName: 'agent', tmux: tmuxById.$8, process: processById.$8 }),
    { id: 'current-session', tmuxName: 'agent', tmux: tmuxById.$8, process: processById.$8 },
  );
  assert.equal(
    findGjcPromotionCandidate(sessions, { tmuxName: 'agent', tmux: tmuxById.$9, process: processById.$9 }),
    null,
  );
  assert.equal(
    findGjcPromotionCandidate(sessions, { tmuxName: 'agent', tmux: tmuxById.$8, process: null }),
    null,
  );
});

test('GJC terminal presence accepts an exact idle row but rejects stale evidence', () => {
  const target = { tmuxName: 'agent', tmux: tmuxById.$8, process: processById.$8 };
  const idle = {
    id: `${GJC_IDLE_SESSION_PREFIX}agent`,
    tmuxName: 'agent',
    tmux: tmuxById.$8,
    process: processById.$8,
    presence: 'present',
  };

  assert.equal(hasGjcTerminalTarget([idle], target), true);
  assert.equal(findGjcPromotionCandidate([idle], target), null);
  assert.equal(hasGjcTerminalTarget([{ ...idle, presence: 'stale' }], target), false);
  assert.equal(
    findGjcPromotionCandidate([
      { ...idle, id: 'structured', presence: 'stale' },
    ], target),
    null,
  );
});

test('readDiscoveryOk accepts only legacy object responses or an explicit discovery success', () => {
  const cases: Array<[unknown, boolean]> = [
    [{ externalSessions: [] }, true],
    [{ discovery: { ok: true } }, true],
    [null, false],
    [[], false],
    ['response', false],
    [{ discovery: undefined }, false],
    [{ discovery: null }, false],
    [{ discovery: [] }, false],
    [{ discovery: {} }, false],
    [{ discovery: { ok: false } }, false],
    [{ discovery: { ok: 'true' } }, false],
    [{ discovery: Object.create({ ok: true }) }, false],
  ];

  for (const [value, expected] of cases) assert.equal(readDiscoveryOk(value), expected);
});
test('readRestSessionContainer rejects malformed expected containers without treating them as empty', () => {
  const session = { id: 'session-1' };
  assert.deepEqual(
    readRestSessionContainer({ externalSessions: [session] }, 'externalSessions'),
    { sessions: [session], discoveryOk: true },
  );
  assert.deepEqual(
    readRestSessionContainer({
      discovery: { ok: true },
      data: { liveSessions: [session] },
    }, 'liveSessions'),
    { sessions: [session], discoveryOk: true },
  );
  assert.deepEqual(
    readRestSessionContainer({
      data: { discovery: { ok: false }, liveSessions: [session] },
    }, 'liveSessions'),
    { sessions: [session], discoveryOk: false },
  );

  for (const malformed of [
    null,
    [],
    {},
    { data: null },
    { data: [] },
    { data: {} },
    { liveSessions: {} },
    { data: { liveSessions: 'not-an-array' } },
  ]) {
    assert.equal(readRestSessionContainer(malformed, 'liveSessions'), null);
  }
});

test('isSameTmuxPaneTarget distinguishes a same-pane process replacement', () => {
  const pane = tmux('%20');
  const original = { tmux: pane, process: process(200) };
  assert.equal(isSameTmuxPaneTarget(original, {
    tmux: { ...pane },
    process: { ...original.process },
  }), true);
  assert.equal(isSameTmuxPaneTarget(original, {
    tmux: pane,
    process: process(201),
  }), false);
});

test('isLiveTmuxActionable accepts fresh stream proof and legacy REST lineage only', () => {
  assert.equal(isLiveTmuxActionable({ tmuxActionable: true }), true);
  assert.equal(isLiveTmuxActionable({}, 'lineage'), true);
  assert.equal(isLiveTmuxActionable({ tmuxActionable: false }, 'cwd'), false);
  assert.equal(isLiveTmuxActionable({}, undefined), false);
});