import assert from 'node:assert/strict';
import test from 'node:test';

import type { DiscoveryV2 } from '../../shared/terminal-runtime';

import { discoveryV2LaneAuthority, discoveryV2ResyncReason, projectDiscoveryV2Rows, DISCOVERY_TRANSPORT_LANES } from './useDiscoveryStream';

const caps = { discovery: true, output: true, actions: true, attach: true, create: false };
const herdr = (sourceId: string, targetId: string) => ({ runtime: 'herdr' as const, sourceId, targetId, targetClass: 'local-agent' as const, process: { pid: 1, startedAtMs: 2 } });
const snapshot = (globalRevision = 4): DiscoveryV2 => ({
  version: 2 as const, epoch: 'epoch-1', globalRevision,
  terminals: [{ lane: 'external' as const, terminal: herdr('hsrc_abcdefghijklmnopqrstuv', 'htgt_abcdefghijklmnopqrstuv') }, { lane: 'external' as const, terminal: herdr('hsrc_bcdefghijklmnopqrstuvw', 'htgt_bcdefghijklmnopqrstuvw') }],
  sourceDescriptors: [],
  sourceLanes: [
    { lane: 'external' as const, sourceId: 'hsrc_abcdefghijklmnopqrstuv', runtime: 'herdr' as const, readiness: 'ready' as const, capabilities: caps, sourceLaneRevision: 4, lastOkGlobalRevision: globalRevision, coverage: 'authoritative' as const, consecutiveFailures: 0 },
    { lane: 'external' as const, sourceId: 'hsrc_bcdefghijklmnopqrstuvw', runtime: 'herdr' as const, readiness: 'ready' as const, capabilities: caps, sourceLaneRevision: 4, lastOkGlobalRevision: globalRevision, coverage: 'authoritative' as const, consecutiveFailures: 0 },
  ],
  coverageByLane: {
    external: { lane: 'external' as const, state: 'complete' as const, expectedSourceLaneKeys: ['external\u0000hsrc_abcdefghijklmnopqrstuv', 'external\u0000hsrc_bcdefghijklmnopqrstuvw'], authoritativeSourceLaneKeys: ['external\u0000hsrc_abcdefghijklmnopqrstuv', 'external\u0000hsrc_bcdefghijklmnopqrstuvw'], retainedSourceLaneKeys: [], unavailableSourceLaneKeys: [] },
    live: { lane: 'live' as const, state: 'complete' as const, expectedSourceLaneKeys: [], authoritativeSourceLaneKeys: [], retainedSourceLaneKeys: [], unavailableSourceLaneKeys: [] },
  },
});

test('uses strict v2 discovery transport', () => assert.deepEqual(DISCOVERY_TRANSPORT_LANES, ['external', 'live']));
test('keeps independent Herdr sources and opaque identities', () => {
  const rows = projectDiscoveryV2Rows(snapshot(), 'external');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => [row.sourceId, row.targetId]), [
    ['hsrc_abcdefghijklmnopqrstuv', 'htgt_abcdefghijklmnopqrstuv'],
    ['hsrc_bcdefghijklmnopqrstuvw', 'htgt_bcdefghijklmnopqrstuvw'],
  ]);
  assert.equal(rows.every((row) => row.runtime === 'herdr' && !('tmux' in row)), true);
});
test('projects authoritative source/lane pairs without clearing peer Herdr or tmux terminals', () => {
  const value = snapshot();
  value.terminals.unshift({
    lane: 'external',
    terminal: { runtime: 'tmux', tmux: { socketPath: '/tmp/tmux', sessionId: '$1', windowId: '@1', paneId: '%1' }, targetClass: 'local-agent', process: { pid: 2, startedAtMs: 3 } },
  });
  value.sourceLanes.unshift({ lane: 'external', sourceId: 'tmux.local', runtime: 'tmux', readiness: 'ready', capabilities: caps, sourceLaneRevision: 4, lastOkGlobalRevision: 4, coverage: 'authoritative', consecutiveFailures: 0 });
  value.sourceLanes[1]!.coverage = 'retained';
  value.coverageByLane.external = {
    lane: 'external',
    state: 'partial',
    expectedSourceLaneKeys: ['external\u0000tmux.local', 'external\u0000hsrc_abcdefghijklmnopqrstuv', 'external\u0000hsrc_bcdefghijklmnopqrstuvw'],
    authoritativeSourceLaneKeys: ['external\u0000tmux.local', 'external\u0000hsrc_bcdefghijklmnopqrstuvw'],
    retainedSourceLaneKeys: ['external\u0000hsrc_abcdefghijklmnopqrstuv'],
    unavailableSourceLaneKeys: [],
  };
  assert.equal(discoveryV2LaneAuthority(value, 'external'), 'rest');
  assert.deepEqual(projectDiscoveryV2Rows(value, 'external').map((row) => row.sourceId), [
    'tmux.local',
    'hsrc_bcdefghijklmnopqrstuvw',
  ]);
});
test('preserves tmux projection only in its explicitly declared lane', () => {
  const value = snapshot();
  value.terminals = [{
    lane: 'live' as const,
    terminal: { runtime: 'tmux' as const, tmux: { socketPath: '/tmp/tmux', sessionId: '$1', windowId: '@1', paneId: '%1' }, targetClass: 'local-agent' as const, process: { pid: 2, startedAtMs: 3 } },
  }];
  value.sourceLanes = [{ lane: 'live', sourceId: 'tmux.local', runtime: 'tmux', readiness: 'ready', capabilities: caps, sourceLaneRevision: 4, lastOkGlobalRevision: 4, coverage: 'authoritative', consecutiveFailures: 0 }];
  value.coverageByLane.live = {
    lane: 'live', state: 'complete', expectedSourceLaneKeys: ['live\u0000tmux.local'],
    authoritativeSourceLaneKeys: ['live\u0000tmux.local'], retainedSourceLaneKeys: [], unavailableSourceLaneKeys: [],
  };
  assert.deepEqual(projectDiscoveryV2Rows(value, 'external'), []);
  assert.equal(projectDiscoveryV2Rows(value, 'live')[0]?.sourceId, 'tmux.local');
});
test('requires exact authoritative source/lane coverage but not a matching global revision', () => {
  const value = snapshot();
  assert.equal(discoveryV2LaneAuthority(value, 'external'), 'stream');
  value.sourceLanes[0].lastOkGlobalRevision = value.globalRevision - 1;
  assert.equal(discoveryV2LaneAuthority(value, 'external'), 'stream');
  (value.sourceLanes[1] as { coverage: string }).coverage = 'retained';
  assert.equal(discoveryV2LaneAuthority(value, 'external'), 'rest');
});
test('rejects stale clients, pair regressions, and same-revision disagreement', () => {
  const current = snapshot();
  const pairs = new Map(current.sourceLanes.map((source) => [`${source.lane}\u0000${source.sourceId}`, source.sourceLaneRevision]));
  assert.equal(discoveryV2ResyncReason(snapshot(3), { epoch: 'epoch-1', revision: 4 }, pairs, null), 'gap');
  assert.equal(discoveryV2ResyncReason(snapshot(6), { epoch: 'epoch-1', revision: 4 }, pairs, null), 'gap');
  const regressed = snapshot(5); regressed.sourceLanes[0].sourceLaneRevision = 3;
  assert.equal(discoveryV2ResyncReason(regressed, { epoch: 'epoch-1', revision: 4 }, pairs, null), 'pair_regression');
  assert.equal(discoveryV2ResyncReason(snapshot(), { epoch: 'epoch-1', revision: 4 }, pairs, JSON.stringify({ different: true })), 'same_revision_disagreement');
});
