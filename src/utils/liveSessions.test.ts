import assert from 'node:assert/strict';
import test from 'node:test';

import type { TmuxPaneIdentity, TmuxProcessGeneration } from '../../shared/tmux';

import {
  findGjcPromotionCandidate,
  GJC_IDLE_SESSION_PREFIX,
  retainTransientlyMissingLiveRows,
  type LiveSessionSnapshotRow,
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
const row = (generationKey: string, lineage = true): LiveSessionSnapshotRow => ({
  tmuxName: 'agent',
  tmux: tmuxById[generationKey],
  process: processById[generationKey],
  model: null,
  effort: null,
  lineage,
  kind: 'interactive',
  running: null,
});

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

test('retainTransientlyMissingLiveRows replaces promoted idle ids without a duplicate grace row', () => {
  const idleId = `${GJC_IDLE_SESSION_PREFIX}agent`;
  const previous = new Map([[idleId, row('$8')]]);
  const current = new Map([['current-session', row('$8')]]);

  const missed = retainTransientlyMissingLiveRows(current, previous, new Set());

  assert.deepEqual([...current.keys()], ['current-session']);
  assert.deepEqual([...missed], []);
});

test('retainTransientlyMissingLiveRows keeps ordinary or different-generation misses for one poll', () => {
  const idleId = `${GJC_IDLE_SESSION_PREFIX}agent`;
  const previous = new Map([
    [idleId, row('$7')],
    ['ordinary-session', row('$6')],
  ]);
  const current = new Map([['current-session', row('$8')]]);

  const firstMiss = retainTransientlyMissingLiveRows(current, previous, new Set());
  assert.deepEqual(new Set(current.keys()), new Set(['current-session', idleId, 'ordinary-session']));
  assert.deepEqual(firstMiss, new Set([idleId, 'ordinary-session']));

  const secondSnapshot = new Map([['current-session', row('$8')]]);
  const secondMiss = retainTransientlyMissingLiveRows(secondSnapshot, current, firstMiss);
  assert.deepEqual([...secondSnapshot.keys()], ['current-session']);
  assert.deepEqual([...secondMiss], []);
});
