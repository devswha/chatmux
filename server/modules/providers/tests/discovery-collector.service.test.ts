import assert from 'node:assert/strict';
import test from 'node:test';

import {
  C_SCAN_IDLE_MS,
  C_SCAN_MS,
  FORCE_REFRESH_DEBOUNCE_MS,
  GRACE_TICKS_EXTERNAL,
  GRACE_TICKS_LIVE,
  UNAVAILABLE_DEGRADE_TICKS,
  createDiscoveryCollector,
  type DiscoveryRow,
} from '@/modules/providers/services/discovery-collector.service.js';
import { IDLE_GJC_ID_PREFIX } from '@/modules/providers/services/live-sessions.service.js';
import type { VerifiedTmuxActionTarget } from '@/modules/providers/services/tmux-fresh-verifier.service.js';

const tmux = { socketPath: '/tmp/tmux-1000/default', sessionId: '$1', windowId: '@1', paneId: '%1' };
const external = { tmuxName: 'shell', tmux, kind: 'ssh' as const, agentPid: 10, startedAtMs: 100 };
const live = {
  id: 'session-1', tmuxName: 'gjc', tmux, process: { pid: 11, startedAtMs: 101 },
  claim: 'lineage' as const, kind: 'interactive' as const, model: null, effort: null, running: true,
};

type SnapshotRowsCannotAuthorize = DiscoveryRow extends VerifiedTmuxActionTarget ? false : true;
const snapshotRowsCannotAuthorize: SnapshotRowsCannotAuthorize = true;
void snapshotRowsCannotAuthorize;

function scans() {
  let externalSessions = [external];
  let externalOk = true;
  let liveSessions = [live];
  let liveOk = true;
  const collector = createDiscoveryCollector({
    now: () => 123,
    scanExternal: async () => ({ ok: externalOk, sessions: externalSessions }),
    scanLive: async () => ({ ok: liveOk, sessions: liveSessions }),
  });
  return {
    collector,
    external(value: typeof externalSessions, ok = true) { externalSessions = value; externalOk = ok; },
    live(value: typeof liveSessions, ok = true) { liveSessions = value; liveOk = ok; },
  };
}

test('discovery collector only advances revision for a changed snapshot', async () => {
  const state = scans();
  await state.collector.tick();
  const first = state.collector.currentSnapshot();
  await state.collector.tick();
  assert.equal(state.collector.currentSnapshot().revision, first.revision);

  state.external([]);
  await state.collector.tick();
  assert.equal(state.collector.currentSnapshot().revision, first.revision + 1);
  assert.equal(state.collector.currentSnapshot().rows.find((row) => row.lane === 'external')?.presence, 'stale');

  await state.collector.tick();
  assert.equal(state.collector.currentSnapshot().revision, first.revision + 2);
  assert.equal(state.collector.currentSnapshot().rows.some((row) => row.lane === 'external'), false);
  assert.equal(GRACE_TICKS_EXTERNAL, 2);
});

test('unavailable lanes retain rows and only degrade health after the threshold', async () => {
  const state = scans();
  await state.collector.tick();
  const initial = state.collector.currentSnapshot();
  state.external([], false);
  for (let tick = 0; tick < UNAVAILABLE_DEGRADE_TICKS - 1; tick += 1) await state.collector.tick();
  assert.equal(state.collector.currentSnapshot().revision, initial.revision);
  assert.equal(state.collector.currentSnapshot().rows.some((row) => row.lane === 'external'), true);

  await state.collector.tick();
  const degraded = state.collector.currentSnapshot();
  assert.equal(degraded.revision, initial.revision + 1);
  assert.deepEqual(degraded.health.external, {
    ok: false,
    lastOkRevision: initial.health.external.lastOkRevision,
    consecutiveFailures: UNAVAILABLE_DEGRADE_TICKS,
  });
});

test('live unavailability preserves rows rather than treating it as a confirmed empty scan', async () => {
  const state = scans();
  await state.collector.tick();
  const initial = state.collector.currentSnapshot();
  state.live([], false);

  await state.collector.tick();

  const snapshot = state.collector.currentSnapshot();
  assert.equal(snapshot.revision, initial.revision);
  assert.equal(snapshot.rows.find((row) => row.lane === 'live')?.presence, 'present');
});
test('row additions and updates advance revision exactly once', async () => {
  const state = scans();
  state.external([]);
  state.live([]);
  await state.collector.tick();
  const emptyRevision = state.collector.currentSnapshot().revision;

  state.external([external]);
  await state.collector.tick();
  assert.equal(state.collector.currentSnapshot().revision, emptyRevision + 1);

  state.external([{ ...external, tmuxName: 'renamed-shell' }]);
  await state.collector.tick();
  assert.equal(state.collector.currentSnapshot().revision, emptyRevision + 2);
});

test('live rows are removed only after their lane grace period', async () => {
  const state = scans();
  await state.collector.tick();
  state.live([]);
  for (let tick = 0; tick < GRACE_TICKS_LIVE - 2; tick += 1) await state.collector.tick();
  assert.equal(state.collector.currentSnapshot().rows.some((row) => row.lane === 'live'), true);
  await state.collector.tick();
  assert.equal(state.collector.currentSnapshot().rows.some((row) => row.lane === 'live'), true);
  await state.collector.tick();
  assert.equal(state.collector.currentSnapshot().rows.some((row) => row.lane === 'live'), false);
});

test('a structured live row replaces an idle row in the same pane without grace', async () => {
  const state = scans();
  state.live([{ ...live, id: `${IDLE_GJC_ID_PREFIX}1` }]);
  await state.collector.tick();
  state.live([live]);
  await state.collector.tick();
  const row = state.collector.currentSnapshot().rows.find((candidate) => candidate.lane === 'live');
  assert.equal(row?.providerSessionId, 'session-1');
  assert.equal(row?.presence, 'present');
});

test('epochs are unique and snapshot payloads exclude transcript paths', async () => {
  const first = scans().collector;
  const second = scans().collector;
  await first.tick();
  assert.notEqual(first.currentSnapshot().epoch, second.currentSnapshot().epoch);
  assert.equal(JSON.stringify(first.currentSnapshot()).includes('transcriptPaths'), false);
});
test('snapshots deeply freeze rows, nested identities, processes, and lane health', async () => {
  const state = scans();
  await state.collector.tick();
  const snapshot = state.collector.currentSnapshot();
  const row = snapshot.rows[0]!;

  assert.throws(() => { (row as { tmuxName: string }).tmuxName = 'mutated'; }, TypeError);
  assert.throws(() => { (row.tmux as { paneId: string }).paneId = '%9'; }, TypeError);
  assert.throws(() => { (row.process as { pid: number }).pid = 99; }, TypeError);
  assert.throws(() => { (snapshot.health.external as { ok: boolean }).ok = false; }, TypeError);
  assert.equal(state.collector.currentSnapshot().rows[0]?.tmux.paneId, '%1');
});

test('collector transitions between idle and active cadence, debounces refresh, and releases timers on shutdown', async () => {
  let nextTimer = 0;
  const scheduled = new Map<number, { callback: () => void; ms: number }>();
  const cleared: number[] = [];
  let scansRun = 0;
  const collector = createDiscoveryCollector({
    setTimer(callback, ms) {
      const id = nextTimer += 1;
      scheduled.set(id, { callback, ms });
      return id as never;
    },
    clearTimer(timer) {
      cleared.push(timer as never as number);
      scheduled.delete(timer as never as number);
    },
    scanExternal: async () => { scansRun += 1; return { ok: true, sessions: [] }; },
    scanLive: async () => ({ ok: true, sessions: [] }),
  });

  collector.start();
  assert.deepEqual([...scheduled.values()].map((timer) => timer.ms), [C_SCAN_IDLE_MS]);
  collector.setActive(true);
  assert.deepEqual([...scheduled.values()].map((timer) => timer.ms), [C_SCAN_MS]);
  collector.setActive(false);
  assert.deepEqual([...scheduled.values()].map((timer) => timer.ms), [C_SCAN_IDLE_MS]);

  collector.forceRefresh();
  collector.forceRefresh();
  const refresh = [...scheduled.values()].find((timer) => timer.ms === FORCE_REFRESH_DEBOUNCE_MS);
  assert.ok(refresh);
  refresh.callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(scansRun, 1);

  collector.dispose();
  assert.equal(scheduled.size, 0);
  assert.ok(cleared.length >= 2);
  await collector.tick();
  assert.equal(scansRun, 1);
});
