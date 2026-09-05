import assert from 'node:assert/strict';
import test from 'node:test';

import {
  C_SCAN_IDLE_MS,
  C_SCAN_MS,
  FORCE_REFRESH_DEBOUNCE_MS,
  GJC_BINDING_GRACE_TICKS,
  GRACE_TICKS_EXTERNAL,
  GRACE_TICKS_LIVE,
  UNAVAILABLE_DEGRADE_TICKS,
  createDiscoveryCollector,
  type DiscoveryRow,
} from '@/modules/providers/services/discovery-collector.service.js';
import {
  IDLE_GJC_ID_PREFIX,
  type LiveGjcSession,
} from '@/modules/providers/services/live-sessions.service.js';
import type { VerifiedTmuxActionTarget } from '@/modules/providers/services/tmux-fresh-verifier.service.js';

const tmux = { socketPath: '/tmp/tmux-1000/default', sessionId: '$1', windowId: '@1', paneId: '%1' };
const external = { tmuxName: 'shell', tmux, kind: 'ssh' as const, agentPid: 10, startedAtMs: 100 };
const live: LiveGjcSession = {
  id: 'session-1', tmuxName: 'gjc', tmux, process: { pid: 11, startedAtMs: 101 },
  claim: 'lineage' as const, kind: 'interactive' as const, model: null, effort: null, running: true, error: false,
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
  assert.equal(
    first.rows.find((row) => row.lane === 'live')?.tmuxActionable,
    true,
    'fresh live discovery rows carry their server-authoritative close permission',
  );
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

test('discovery collector publishes GJC provider failures as error activity', async () => {
  const state = scans();
  state.live([{ ...live, running: false, error: true }]);
  await state.collector.tick();

  assert.equal(
    state.collector.currentSnapshot().rows.find((row) => row.lane === 'live')?.activity,
    'error',
  );
});

test('GJC binding changes propagate independently of pane lineage and advance discovery', async () => {
  const state = scans();
  let previousRevision = 0;
  for (const binding of ['observed', 'inferred', undefined] as const) {
    state.live([{ ...live, binding }]);
    await state.collector.tick();
    const snapshot = state.collector.currentSnapshot();
    const row = snapshot.rows.find((value) => value.lane === 'live');
    assert.equal(row?.binding, binding);
    assert.equal(row?.tmuxActionable, true, 'pane lineage remains independent of the transcript binding');
    assert.ok(snapshot.revision > previousRevision);
    previousRevision = snapshot.revision;
  }
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
  await state.collector.tick();
  assert.equal(state.collector.currentSnapshot().rows.some((row) => row.lane === 'live'), true);
  await state.collector.tick();
  assert.equal(state.collector.currentSnapshot().rows.some((row) => row.lane === 'live'), false);
  assert.equal(GRACE_TICKS_LIVE, 2);
});

test('a temporary GJC receipt gap preserves the bound conversation while the process stays alive', async () => {
  const state = scans();
  await state.collector.tick();
  const idle = {
    ...live,
    id: `${IDLE_GJC_ID_PREFIX}gjc:%1`,
    model: null,
    effort: null,
    running: null,
    error: null,
  };
  state.live([idle]);

  for (let tick = 1; tick < GJC_BINDING_GRACE_TICKS; tick += 1) {
    await state.collector.tick();
    const row = state.collector.currentSnapshot().rows.find((candidate) => candidate.lane === 'live');
    assert.equal(row?.providerSessionId, 'session-1');
    assert.equal(row?.presence, 'present');
  }

  state.live([{ ...live, id: 'session-resumed', running: false }]);
  await state.collector.tick();
  const resumed = state.collector.currentSnapshot().rows.find((candidate) => candidate.lane === 'live');
  assert.equal(resumed?.providerSessionId, 'session-resumed');
  assert.equal(resumed?.presence, 'present');
});

test('a persistent GJC receipt gap eventually exposes the safe unbound process row', async () => {
  const state = scans();
  await state.collector.tick();
  const idleId = `${IDLE_GJC_ID_PREFIX}gjc:%1`;
  state.live([{
    ...live,
    id: idleId,
    model: null,
    effort: null,
    running: null,
    error: null,
  }]);

  for (let tick = 0; tick < GJC_BINDING_GRACE_TICKS; tick += 1) {
    await state.collector.tick();
  }

  const row = state.collector.currentSnapshot().rows.find((candidate) => candidate.lane === 'live');
  assert.equal(row?.providerSessionId, idleId);
  assert.equal(row?.presence, 'present');
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

test('a same-name tmux session replacement removes the stale generation immediately', async () => {
  const state = scans();
  await state.collector.tick();

  const replacement = {
    ...live,
    id: 'session-2',
    tmux: { ...tmux, sessionId: '$2', windowId: '@2', paneId: '%2' },
    process: { pid: 12, startedAtMs: 102 },
  };
  state.live([replacement]);
  await state.collector.tick();

  const liveRows = state.collector.currentSnapshot().rows.filter((row) => row.lane === 'live');
  assert.equal(liveRows.length, 1);
  assert.equal(liveRows[0]?.providerSessionId, 'session-2');
  assert.equal(liveRows[0]?.presence, 'present');
});

test('epochs are unique and snapshot payloads exclude transcript paths', async () => {
  const first = scans().collector;
  const second = scans().collector;
  await first.tick();
  assert.notEqual(first.currentSnapshot().epoch, second.currentSnapshot().epoch);
  assert.equal(JSON.stringify(first.currentSnapshot()).includes('transcriptPaths'), false);
});

test('collector shares one fresh detailed scan with UI and notification consumers', async () => {
  let now = 1_000;
  let externalScans = 0;
  let liveScans = 0;
  const transcriptPaths = new Map([['session-1', '/private/transcript.jsonl']]);
  const collector = createDiscoveryCollector({
    now: () => now,
    scanExternal: async () => {
      externalScans += 1;
      return { ok: true, sessions: [external] };
    },
    scanLive: async () => {
      liveScans += 1;
      return { ok: true, sessions: [live], transcriptPaths };
    },
  });

  await Promise.all([
    collector.ensureFresh(5_000),
    collector.ensureFresh(5_000),
    collector.tick(),
  ]);
  assert.equal(externalScans, 1);
  assert.equal(liveScans, 1);
  assert.equal(collector.currentDetailed().live?.transcriptPaths, transcriptPaths);
  assert.equal(JSON.stringify(collector.currentSnapshot()).includes('/private/transcript.jsonl'), false);

  now += 4_999;
  await collector.ensureFresh(5_000);
  assert.equal(externalScans, 1);
  now += 2;
  await collector.ensureFresh(5_000);
  assert.equal(externalScans, 2);
});

test('a forced freshness check performs full discovery despite an unchanged host fingerprint', async () => {
  let now = 1_000;
  let externalScans = 0;
  let holdProbe = false;
  let releaseProbe = () => {};
  let probeStarted = () => {};
  const waitForProbe = new Promise<void>((resolve) => { probeStarted = resolve; });
  const collector = createDiscoveryCollector({
    now: () => now,
    scanExternal: async () => {
      externalScans += 1;
      return { ok: true, sessions: [external] };
    },
    scanLive: async () => ({ ok: true, sessions: [] }),
    scanHost: async () => {
      if (holdProbe) {
        probeStarted();
        await new Promise<void>((resolve) => { releaseProbe = resolve; });
      }
      return {
        ok: true,
        capturedAtMs: now,
        panes: [{ name: external.tmuxName, tmux, pid: external.agentPid, command: 'ssh' }],
      };
    },
    isProcessAlive: async () => true,
  });

  await collector.tick();
  now += 1;
  await collector.ensureFresh(0);
  assert.equal(externalScans, 2);
  now += 1;
  await collector.ensureFresh(2_000, true);
  assert.equal(externalScans, 3);

  holdProbe = true;
  now += 1;
  const nonForcedTick = collector.ensureFresh(0);
  await waitForProbe;
  const forcedTick = collector.ensureFresh(2_000, true);
  releaseProbe();
  await Promise.all([nonForcedTick, forcedTick]);
  assert.equal(externalScans, 4, 'a forced caller waits for a full tick after an in-flight probe');
});

test('stable one-second host probes skip full discovery until panes change or stale rows need confirmation', async () => {
  let now = 1_000;
  let externalScans = 0;
  let liveScans = 0;
  let hostScans = 0;
  let externalSessions = [external];
  let panes = [{
    name: external.tmuxName,
    tmux,
    pid: external.agentPid,
    command: 'ssh',
  }];
  const collector = createDiscoveryCollector({
    now: () => now,
    scanExternal: async () => {
      externalScans += 1;
      return { ok: true, sessions: externalSessions };
    },
    scanLive: async () => {
      liveScans += 1;
      return { ok: true, sessions: [] };
    },
    scanHost: async () => {
      hostScans += 1;
      return { ok: true, capturedAtMs: now, panes };
    },
    isProcessAlive: async () => true,
  });

  await collector.tick();
  now += 1;
  await collector.ensureFresh(0);
  assert.equal(externalScans, 2, 'the first probe establishes its pane fingerprint');

  now += 1;
  await collector.ensureFresh(0);
  assert.equal(hostScans, 2);
  assert.equal(externalScans, 2, 'an unchanged fingerprint reuses detailed discovery');
  assert.equal(liveScans, 2);

  externalSessions = [];
  panes = [];
  now += 1;
  await collector.ensureFresh(0);
  assert.equal(externalScans, 3);
  assert.equal(
    collector.currentSnapshot().rows.find((row) => row.lane === 'external')?.presence,
    'stale',
  );

  now += 1;
  await collector.ensureFresh(0);
  assert.equal(externalScans, 4, 'stale rows keep full scans running through removal grace');
  assert.equal(collector.currentSnapshot().rows.some((row) => row.lane === 'external'), false);
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
