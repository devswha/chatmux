import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GJC_WATCH_DEGRADED_RETRY_MS,
  GJC_WATCH_MAX_FAST_FAILURES,
  chokidarWatchTarget,
  getGjcWatcherHealth,
  nativeWatchProviderForPath,
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

test('native watcher paths map events to their owning provider without prefix confusion', () => {
  assert.equal(
    nativeWatchProviderForPath(`${process.env.HOME}/.codex/sessions/${new Date().getFullYear()}/08/31/session.jsonl`),
    'codex',
  );
  assert.equal(
    nativeWatchProviderForPath(`${process.env.HOME}/.claude/projects/workspace/session.jsonl`),
    'claude',
  );
  assert.equal(nativeWatchProviderForPath('/tmp/not-a-chatmux-provider/session.jsonl'), null);
});

test('OpenCode watches only its SQLite database while directory-backed providers keep their root', () => {
  assert.equal(chokidarWatchTarget('opencode', '/state/opencode'), '/state/opencode/opencode.db');
  assert.equal(chokidarWatchTarget('cursor', '/state/cursor'), '/state/cursor');
});
