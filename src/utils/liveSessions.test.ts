import assert from 'node:assert/strict';
import test from 'node:test';

import type { TmuxPaneIdentity, TmuxProcessGeneration } from '../../shared/tmux';

import {
  findGjcPromotionCandidate,
  GJC_IDLE_SESSION_PREFIX,
  readDiscoveryOk,
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

test('readDiscoveryOk treats missing discovery metadata as a legacy available response', () => {
  assert.equal(readDiscoveryOk({ externalSessions: [] }), true);
  assert.equal(readDiscoveryOk({ discovery: {} }), true);
  assert.equal(readDiscoveryOk({ discovery: { ok: false } }), false);
});