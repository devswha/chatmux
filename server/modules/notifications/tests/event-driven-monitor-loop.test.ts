import assert from 'node:assert/strict';
import test from 'node:test';

import {
  startEventDrivenMonitorLoop,
  type MonitorLoopScheduledTask,
  type MonitorLoopScheduler,
} from '@/modules/notifications/services/event-driven-monitor-loop.service.js';

type ScheduledEntry = {
  atMs: number;
  readonly callback: () => void;
  readonly intervalMs: number | null;
};

class ManualScheduler implements MonitorLoopScheduler {
  private nowMs = 0;
  private sequence = 0;
  private readonly entries = new Map<number, ScheduledEntry>();

  schedule(delayMs: number, callback: () => void): MonitorLoopScheduledTask {
    return this.add(delayMs, null, callback);
  }

  repeat(intervalMs: number, callback: () => void): MonitorLoopScheduledTask {
    return this.add(intervalMs, intervalMs, callback);
  }

  async advance(durationMs: number): Promise<void> {
    await Promise.resolve();
    const targetMs = this.nowMs + durationMs;
    while (true) {
      const next = [...this.entries.entries()]
        .sort((left, right) => left[1].atMs - right[1].atMs || left[0] - right[0])[0];
      if (next === undefined || next[1].atMs > targetMs) break;
      const [id, entry] = next;
      this.nowMs = entry.atMs;
      if (entry.intervalMs === null) {
        this.entries.delete(id);
      } else {
        entry.atMs += entry.intervalMs;
      }
      entry.callback();
    }
    this.nowMs = targetMs;
  }

  private add(delayMs: number, intervalMs: number | null, callback: () => void): MonitorLoopScheduledTask {
    this.sequence += 1;
    const id = this.sequence;
    this.entries.set(id, { atMs: this.nowMs + delayMs, callback, intervalMs });
    return { cancel: () => { this.entries.delete(id); } };
  }
}

class TickObserver {
  count = 0;
  concurrent = 0;
  maxConcurrent = 0;
  private completedCount = 0;
  private readonly started = new Map<number, () => void>();
  private readonly completed = new Map<number, () => void>();
  private blocker: Promise<void> | null = null;

  readonly tick = async (): Promise<void> => {
    this.count += 1;
    this.concurrent += 1;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.concurrent);
    this.started.get(this.count)?.();
    this.started.delete(this.count);
    if (this.blocker !== null) {
      const blocker = this.blocker;
      this.blocker = null;
      await blocker;
    }
    this.concurrent -= 1;
    this.completedCount += 1;
    this.completed.get(this.completedCount)?.();
    this.completed.delete(this.completedCount);
  };

  whenStarted(tickNumber: number): Promise<void> {
    return new Promise((resolve) => { this.started.set(tickNumber, resolve); });
  }

  whenCompleted(tickNumber: number): Promise<void> {
    return new Promise((resolve) => { this.completed.set(tickNumber, resolve); });
  }

  blockNext(): () => void {
    const gate = Promise.withResolvers<void>();
    this.blocker = gate.promise;
    return gate.resolve;
  }
}

test('relevant event bursts run immediately and once more after becoming quiet', { timeout: 1_000 }, async () => {
  // Given
  const scheduler = new ManualScheduler();
  const observer = new TickObserver();
  const subscriber: { listener: ((event: string) => void) | null } = { listener: null };
  const startup = observer.whenCompleted(1);

  // When
  const stop = startEventDrivenMonitorLoop({
    tick: observer.tick,
    subscribe: (next) => {
      subscriber.listener = next;
      return () => { subscriber.listener = null; };
    },
    accepts: (event) => event === 'codex',
    fallbackMs: 1_000,
    quietMs: 20,
    scheduler,
  });
  await startup;

  // Then
  assert.equal(observer.count, 1, 'startup establishes the baseline immediately');
  subscriber.listener?.('gjc');
  assert.equal(observer.count, 1, 'unrelated providers do not wake the monitor');

  const leading = observer.whenCompleted(2);
  subscriber.listener?.('codex');
  subscriber.listener?.('codex');
  await leading;
  assert.equal(observer.count, 2, 'one leading-edge tick serves the burst');

  const trailing = observer.whenCompleted(3);
  await scheduler.advance(20);
  await trailing;
  assert.equal(observer.count, 3, 'one trailing tick observes the settled transcript');
  stop();
  assert.equal(subscriber.listener, null);
});

test('an event during a slow tick queues one non-overlapping follow-up', { timeout: 1_000 }, async () => {
  // Given
  const scheduler = new ManualScheduler();
  const observer = new TickObserver();
  const releaseStartup = observer.blockNext();
  const startupStarted = observer.whenStarted(1);
  const subscriber: { listener: ((event: string) => void) | null } = { listener: null };
  const stop = startEventDrivenMonitorLoop({
    tick: observer.tick,
    subscribe: (next) => {
      subscriber.listener = next;
      return () => { subscriber.listener = null; };
    },
    accepts: () => true,
    fallbackMs: 1_000,
    quietMs: 20,
    scheduler,
  });
  await startupStarted;

  // When
  const followUpCompleted = observer.whenCompleted(2);
  subscriber.listener?.('codex');
  releaseStartup();
  await followUpCompleted;

  // Then
  assert.equal(observer.count, 2);
  assert.equal(observer.maxConcurrent, 1);
  stop();
});

test('fallback intervals do not queue catch-up ticks behind a slow monitor tick', { timeout: 1_000 }, async () => {
  // Given
  const scheduler = new ManualScheduler();
  const observer = new TickObserver();
  const releaseStartup = observer.blockNext();
  const startupStarted = observer.whenStarted(1);
  const startupCompleted = observer.whenCompleted(1);
  const stop = startEventDrivenMonitorLoop({
    tick: observer.tick,
    subscribe: () => () => {},
    accepts: () => true,
    fallbackMs: 50,
    scheduler,
  });
  await startupStarted;

  // When
  await scheduler.advance(70);
  releaseStartup();
  await startupCompleted;

  // Then
  assert.equal(observer.count, 1);
  stop();
});

test('the fallback catches a missed event without constant polling', { timeout: 1_000 }, async () => {
  // Given
  const scheduler = new ManualScheduler();
  const observer = new TickObserver();
  const startup = observer.whenCompleted(1);
  const stop = startEventDrivenMonitorLoop({
    tick: observer.tick,
    subscribe: () => () => {},
    accepts: () => true,
    fallbackMs: 20,
    quietMs: 5,
    scheduler,
  });
  await startup;

  // When
  const fallback = observer.whenCompleted(2);
  await scheduler.advance(20);
  await fallback;

  // Then
  assert.equal(observer.count, 2);
  stop();
});
