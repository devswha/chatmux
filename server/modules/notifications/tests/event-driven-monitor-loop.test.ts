import assert from 'node:assert/strict';
import test from 'node:test';

import { startEventDrivenMonitorLoop } from '@/modules/notifications/services/event-driven-monitor-loop.service.js';

const wait = (ms: number): Promise<void> => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

test('relevant event bursts run immediately and once more after becoming quiet', async () => {
  const subscriber: { listener: ((event: string) => void) | null } = { listener: null };
  let ticks = 0;
  const stop = startEventDrivenMonitorLoop({
    tick: async () => { ticks += 1; },
    subscribe: (next) => {
      subscriber.listener = next;
      return () => { subscriber.listener = null; };
    },
    accepts: (event) => event === 'codex',
    fallbackMs: 1_000,
    quietMs: 20,
  });
  await wait(5);
  assert.equal(ticks, 1, 'startup establishes the baseline immediately');

  subscriber.listener?.('gjc');
  await wait(5);
  assert.equal(ticks, 1, 'unrelated providers do not wake the monitor');

  subscriber.listener?.('codex');
  subscriber.listener?.('codex');
  await wait(5);
  assert.equal(ticks, 2, 'one leading-edge tick serves the burst');
  await wait(25);
  assert.equal(ticks, 3, 'one trailing tick observes the settled transcript');
  stop();
  assert.equal(subscriber.listener, null);
});

test('an event during a slow tick queues one non-overlapping follow-up', async () => {
  const subscriber: { listener: ((event: string) => void) | null } = { listener: null };
  const gate: { release: (() => void) | null } = { release: null };
  let ticks = 0;
  let concurrent = 0;
  let maxConcurrent = 0;
  const stop = startEventDrivenMonitorLoop({
    tick: async () => {
      ticks += 1;
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      if (ticks === 1) {
        await new Promise<void>((resolve) => { gate.release = resolve; });
      }
      concurrent -= 1;
    },
    subscribe: (next) => {
      subscriber.listener = next;
      return () => { subscriber.listener = null; };
    },
    accepts: () => true,
    fallbackMs: 1_000,
    quietMs: 20,
  });
  await wait(5);
  subscriber.listener?.('codex');
  gate.release?.();
  await wait(10);
  assert.equal(ticks, 2);
  assert.equal(maxConcurrent, 1);
  stop();
});

test('the fallback catches a missed event without constant polling', async () => {
  let ticks = 0;
  const stop = startEventDrivenMonitorLoop({
    tick: async () => { ticks += 1; },
    subscribe: () => () => {},
    accepts: () => true,
    fallbackMs: 20,
    quietMs: 5,
  });
  await wait(5);
  assert.equal(ticks, 1);
  await wait(25);
  assert.ok(ticks >= 2);
  stop();
});
