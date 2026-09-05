import assert from 'node:assert/strict';
import test from 'node:test';

import { getSessionIndexingDiagnostics, type DiscoveryCollector, type DiscoveryRow } from '@/modules/providers/index.js';

import {
  createDiagnosticsService,
  DIAGNOSTICS_CACHE_TTL_MS,
  DIAGNOSTICS_MAX_AGE_MS,
  DIAGNOSTICS_MAX_ROWS,
  type DiagnosticsDependencies,
} from './diagnostics.service.js';

const PRIVATE = 'PRIVATE_DIAGNOSTIC_SENTINEL';

function fixture() {
  let now = 100_000;
  let reads = 0;
  let indexingReads = 0;
  const rows: DiscoveryRow[] = [{
    key: PRIVATE, lane: 'external', tmuxName: PRIVATE,
    tmux: { socketPath: PRIVATE, sessionId: PRIVATE, windowId: PRIVATE, paneId: PRIVATE },
    process: { pid: 987654, startedAtMs: 123 }, kind: PRIVATE,
    providerSessionId: PRIVATE, cwd: PRIVATE, lastSeenRevision: 1,
    presence: 'stale', staleSinceRevision: 1, activity: 'unknown',
    connectionIssue: 'transcript_permission_denied',
  }];
  const detailed = {
    takenAtMs: 99_000 as number | null,
    external: { ok: true, sessions: [], rawError: PRIVATE },
    live: { ok: true, sessions: [], transcriptPaths: new Map([[PRIVATE, PRIVATE]]) },
  };
  const state = {
    running: true, active: false, scanning: false, disposed: false,
    lastFullScanAtMs: 98_000, consecutiveFailures: { external: 0, live: 0 },
    argv: PRIVATE,
  };
  const health = {
    external: { ok: true, lastOkRevision: 1, consecutiveFailures: 0 },
    live: { ok: true, lastOkRevision: 1, consecutiveFailures: 0 },
  };
  const collector: Pick<DiscoveryCollector, 'currentSnapshot' | 'currentDetailed' | 'getState'> = {
    currentSnapshot: () => { reads++; return { epoch: PRIVATE, revision: 1, takenAtMs: 99_000, rows, health }; },
    currentDetailed: () => detailed,
    getState: () => state,
  };
  const watcher = { ok: true, degraded: false, consecutiveFailures: 0, enospcObserved: false, token: PRIVATE };
  const indexing = {
    pending: 12, active: 3, maxPending: 448, maxActive: 4,
    reconciling: 1, reconciliationPending: 2, overflowed: 25, failures: 6, closed: false,
    transcriptPaths: [PRIVATE], rawError: PRIVATE, token: PRIVATE,
    reconcile: () => assert.fail('diagnostics must never reconcile'),
  };
  const dependencies: DiagnosticsDependencies = {
    collector: () => collector, watcher: () => watcher,
    indexing: () => { indexingReads++; return indexing; }, now: () => now, eventLoopUtilization: () => 0.123456,
  };
  return {
    rows, detailed, state, health, watcher, indexing, dependencies,
    indexingReads: () => indexingReads,
    setNow: (value: number) => { now = value; }, reads: () => reads,
    service: createDiagnosticsService(dependencies),
  };
}

test('cached reads project only allowlisted aggregate fields and bounded platform utilization', () => {
  const subject = fixture();
  const data = subject.service.read();
  assert.equal(data.collector.mode, 'idle');
  assert.equal(data.collector.freshness, 'fresh');
  assert.equal(data.collector.scanAgeMs, 1_000);
  assert.equal(data.collector.fullScanAgeMs, 2_000);
  assert.deepEqual(data.collector.lanes.external, { status: 'ok', consecutiveFailures: 0, rows: 1, staleRows: 1 });
  assert.deepEqual(data.collector.connectionIssues, [{ code: 'transcript_permission_denied', count: 1 }]);
  assert.equal(data.gjcWatcher.status, 'no_failures_reported');
  assert.equal(data.eventLoop.utilization, 0.1235);
  assert.deepEqual(data.indexing, {
    status: 'accepting', pending: 12, active: 3, maxPending: 448, maxActive: 4,
    reconciling: 1, reconciliationPending: 2, overflowed: 25, failures: 6,
  });
  const json = JSON.stringify(data);
  assert.ok(json.length < 2_000);
  assert.doesNotMatch(json, /PRIVATE_DIAGNOSTIC_SENTINEL|987654|socketPath|providerSessionId|transcriptPaths|argv|rawError|token|cwd|epoch/);
});

test('all callers share a two-second cache without invoking collector mutations', () => {
  const subject = fixture();
  const first = subject.service.read();
  subject.state.consecutiveFailures.external = 1;
  subject.indexing.pending = 44;
  subject.setNow(100_000 + DIAGNOSTICS_CACHE_TTL_MS - 1);
  for (let i = 0; i < 20; i++) assert.equal(subject.service.read(), first);
  assert.equal(subject.reads(), 1);
  assert.equal(subject.indexingReads(), 1);
  assert.equal(first.indexing.pending, 12);
  subject.setNow(100_000 + DIAGNOSTICS_CACHE_TTL_MS);
  const second = subject.service.read();
  assert.notEqual(second, first);
  assert.equal(second.collector.lanes.external.status, 'failing');
  assert.equal(first.collector.lanes.external.consecutiveFailures, 0);
  assert.equal(subject.reads(), 2);
  assert.equal(subject.indexingReads(), 2);
  assert.equal(second.indexing.pending, 44);
  subject.setNow(50_000);
  assert.notEqual(subject.service.read(), second, 'clock rollback must expire the cache');
});

test('bootstrap, stale observations, failed lanes, and successful full scan ages remain distinct', () => {
  const subject = fixture();
  subject.detailed.takenAtMs = null;
  assert.equal(subject.service.read().collector.freshness, 'waiting');
  subject.setNow(150_000);
  subject.detailed.takenAtMs = 99_000;
  subject.detailed.external.ok = false;
  subject.state.consecutiveFailures.external = 4;
  const failing = subject.service.read().collector;
  assert.equal(failing.freshness, 'stale');
  assert.equal(failing.lanes.external.status, 'failing');
  assert.equal(failing.lanes.external.consecutiveFailures, 4);
  assert.equal(failing.fullScanAgeMs, 52_000);
  subject.health.external.ok = false;
  subject.setNow(152_000);
  assert.equal(subject.service.read().collector.lanes.external.status, 'degraded');
});

test('unknown reasons are omitted and retained row work and response size stay bounded', () => {
  const subject = fixture();
  subject.rows.push({ ...subject.rows[0], connectionIssue: PRIVATE } as unknown as DiscoveryRow);
  subject.rows.push(...Array.from({ length: 2_000 }, () => subject.rows[0]));
  const data = subject.service.read();
  assert.equal(data.collector.rowsTruncated, true);
  assert.equal(data.collector.lanes.external.rows, DIAGNOSTICS_MAX_ROWS);
  assert.deepEqual(data.collector.connectionIssues, [{ code: 'transcript_permission_denied', count: DIAGNOSTICS_MAX_ROWS - 1 }]);
  assert.doesNotMatch(JSON.stringify(data), new RegExp(PRIVATE));
});

test('source failures remain independent, generic, cached, and silent', () => {
  const subject = fixture();
  subject.dependencies.collector = () => { throw new Error(PRIVATE); };
  let calls = 0;
  subject.dependencies.watcher = () => { calls++; throw new Error(PRIVATE); };
  subject.dependencies.eventLoopUtilization = () => { throw new Error(PRIVATE); };
  const service = createDiagnosticsService(subject.dependencies);
  const data = service.read();
  assert.equal(data.collector.status, 'unavailable');
  assert.equal(data.gjcWatcher.status, 'unavailable');
  assert.equal(data.eventLoop.utilization, null);
  assert.equal(service.read(), data);
  assert.equal(calls, 1);
  assert.doesNotMatch(JSON.stringify(data), new RegExp(PRIVATE));
  subject.dependencies.watcher = () => subject.watcher;
  subject.setNow(102_000);
  assert.equal(service.read().gjcWatcher.status, 'no_failures_reported');
});

test('watcher degradation and watch limits are reported without claiming liveness', () => {
  const subject = fixture();
  subject.watcher.ok = false;
  subject.watcher.consecutiveFailures = 3;
  assert.equal(subject.service.read().gjcWatcher.status, 'retrying');
  subject.watcher.degraded = true;
  subject.watcher.enospcObserved = true;
  subject.watcher.consecutiveFailures = 9_999_999;
  subject.setNow(102_000);
  assert.deepEqual(subject.service.read().gjcWatcher, {
    status: 'degraded', consecutiveFailures: 1_000_000, watchLimitObserved: true,
  });
});

test('invalid numeric signals are unavailable and observation ages are capped', () => {
  for (const timestamp of [NaN, Infinity, -1, 100_001]) {
    const subject = fixture();
    subject.detailed.takenAtMs = timestamp;
    subject.state.consecutiveFailures.external = NaN;
    subject.dependencies.eventLoopUtilization = () => Infinity;
    const data = createDiagnosticsService(subject.dependencies).read();
    assert.equal(data.collector.scanAgeMs, null);
    assert.equal(data.collector.freshness, 'unavailable');
    assert.equal(data.collector.lanes.external.consecutiveFailures, 0);
    assert.equal(data.eventLoop.utilization, null);
  }
  const subject = fixture();
  subject.setNow(DIAGNOSTICS_MAX_AGE_MS * 2);
  assert.equal(subject.service.read().collector.scanAgeMs, DIAGNOSTICS_MAX_AGE_MS);
});

test('missing collector accessors remain unknown and stopped/disposed state is explicit', () => {
  const subject = fixture();
  subject.state.running = false;
  assert.equal(subject.service.read().collector.mode, 'stopped');
  subject.state.disposed = true;
  subject.setNow(102_000);
  assert.equal(subject.service.read().collector.mode, 'disposed');
  const collector = subject.dependencies.collector();
  assert.ok(collector);
  delete collector.getState;
  subject.setNow(104_000);
  assert.equal(subject.service.read().collector.mode, 'unknown');
});


test('optional or failed indexing metadata is unavailable, cached, and independent of other sources', () => {
  for (const source of [undefined, () => null, () => undefined, () => { throw new Error(PRIVATE); }]) {
    const subject = fixture();
    subject.dependencies.indexing = source;
    const service = createDiagnosticsService(subject.dependencies);
    const data = service.read();
    assert.deepEqual(data.indexing, {
      status: 'unavailable', pending: null, active: null, maxPending: null, maxActive: null,
      reconciling: null, reconciliationPending: null, overflowed: null, failures: null,
    });
    assert.equal(data.collector.status, 'available');
    assert.equal(data.gjcWatcher.status, 'no_failures_reported');
    assert.equal(data.eventLoop.utilization, 0.1235);
    assert.equal(service.read(), data);
    assert.doesNotMatch(JSON.stringify(data), new RegExp(PRIVATE));
  }
});

test('indexing counters have explicit bounds and invalid values remain unknown instead of healthy zero', () => {
  const subject = fixture();
  Object.assign(subject.indexing, {
    pending: 5.9, active: -1, maxPending: Infinity, maxActive: undefined,
    reconciling: NaN, reconciliationPending: PRIVATE, overflowed: Number.MAX_SAFE_INTEGER, failures: -9,
    closed: PRIVATE,
  });
  assert.deepEqual(subject.service.read().indexing, {
    status: 'unavailable', pending: 5, active: null, maxPending: null, maxActive: null,
    reconciling: null, reconciliationPending: null, overflowed: 1_000_000, failures: null,
  });
});

test('indexing admission is independent of activity and only allowlisted properties are accessed', () => {
  const subject = fixture();
  Object.defineProperty(subject.indexing, 'filePaths', { enumerable: true, get: () => assert.fail('must not inspect private paths') });
  subject.indexing.active = 0;
  subject.indexing.pending = 0;
  assert.equal(subject.service.read().indexing.status, 'accepting', 'idle or paused admission is not liveness');
  subject.indexing.closed = true;
  subject.indexing.active = 2;
  subject.setNow(102_000);
  assert.equal(subject.service.read().indexing.status, 'closed');
  assert.equal(subject.service.read().indexing.active, 2, 'closed admission may still be draining active work');
});

test('providers export cached indexing metadata without starting watchers or including bulk synchronization', () => {
  const subject = fixture();
  subject.dependencies.indexing = getSessionIndexingDiagnostics;
  const data = createDiagnosticsService(subject.dependencies).read();
  assert.deepEqual(data.indexing, {
    status: 'closed', pending: 0, active: 0, maxPending: 448, maxActive: 4,
    reconciling: 0, reconciliationPending: 0, overflowed: 0, failures: 0,
  });
});
