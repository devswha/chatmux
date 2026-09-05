import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GJC_WATCH_DEGRADED_RETRY_MS,
  GJC_WATCH_MAX_FAST_FAILURES,
  getGjcWatcherHealth,
  getSessionIndexingDiagnostics,
  nextGjcWatcherRestartDelayMs,
} from '@/modules/providers/services/sessions-watcher.service.js';

// #42 regression lock: the native watcher supervisor used to retry every 30s
// forever (measured: 1752 consecutive failures over 14.5h under inotify
// ENOSPC). Below the cap the fast exponential backoff is unchanged; at the cap
// the schedule degrades to slow probes so recovery stays automatic without a
// permanent crash loop.
test('restart schedule keeps the fast backoff below the failure cap', () => {
  let delayMs = 1_000;
  const delays: number[] = [];
  for (let failures = 1; failures < GJC_WATCH_MAX_FAST_FAILURES; failures += 1) {
    const schedule = nextGjcWatcherRestartDelayMs(failures, delayMs);
    assert.equal(schedule.degraded, false, `failure ${failures} must stay in the fast lane`);
    delays.push(schedule.delayMs);
    delayMs = schedule.nextDelayMs;
  }
  assert.deepEqual(delays.slice(0, 6), [1_000, 2_000, 4_000, 8_000, 16_000, 30_000]);
  assert.ok(delays.every((delay) => delay <= 30_000));
});

test('at the cap the schedule degrades to slow probes and stays there', () => {
  for (const failures of [GJC_WATCH_MAX_FAST_FAILURES, GJC_WATCH_MAX_FAST_FAILURES + 1, 1_752]) {
    const schedule = nextGjcWatcherRestartDelayMs(failures, 30_000);
    assert.equal(schedule.degraded, true, String(failures));
    assert.equal(schedule.delayMs, GJC_WATCH_DEGRADED_RETRY_MS);
  }
});

test('watcher health starts clean and its shape is stable for status surfaces', () => {
  assert.deepEqual(getGjcWatcherHealth(), {
    ok: true,
    consecutiveFailures: 0,
    degraded: false,
    enospcObserved: false,
  });
});

test('indexing diagnostics are bounded metadata and cannot mutate watcher state', () => {
  const first = getSessionIndexingDiagnostics();
  assert.deepEqual(first, {
    pending: 0, active: 0, reconciling: 0, reconciliationPending: 0,
    maxPending: 448, maxActive: 4, overflowed: 0, failures: 0, closed: true,
  });
  first.pending = 123;
  for (let read = 0; read < 1_000; read += 1) {
    assert.equal(getSessionIndexingDiagnostics().pending, 0);
  }
});
