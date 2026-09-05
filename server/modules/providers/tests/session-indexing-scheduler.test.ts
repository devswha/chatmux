import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createSessionIndexingScheduler,
  type SessionFileUpdate,
} from '@/modules/providers/services/session-indexing-scheduler.js';
import type { LLMProvider } from '@/shared/types.js';

class Clock {
  time = 0;
  maximumTimers = 0;
  private nextId = 0;
  readonly timers = new Map<number, { at: number; callback: () => void }>();
  now = () => this.time;
  schedule = (callback: () => void, delay: number) => {
    const id = ++this.nextId;
    this.timers.set(id, { at: this.time + delay, callback });
    this.maximumTimers = Math.max(this.maximumTimers, this.timers.size);
    return () => { this.timers.delete(id); };
  };
  async tick(ms = 0): Promise<void> {
    const target = this.time + ms;
    for (let count = 0; count < 10_000; count += 1) {
      for (let flush = 0; flush < 20; flush += 1) await Promise.resolve();
      const next = [...this.timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > target) { this.time = target; return; }
      this.time = next[1].at;
      this.timers.delete(next[0]);
      next[1].callback();
    }
    assert.fail('scheduler failed to quiesce');
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
const update = (provider: LLMProvider, filePath: string, eventType: 'add' | 'change' = 'change'): SessionFileUpdate => ({
  provider, filePath, eventType,
});
async function* noReconciliation(): AsyncGenerator<void> {}

function harness(overrides: Partial<Parameters<typeof createSessionIndexingScheduler>[0]> = {}) {
  const clock = new Clock();
  const scheduler = createSessionIndexingScheduler({
    providers: ['claude', 'codex', 'gjc'],
    maxPendingPerProvider: 2, maxActive: 2, debounceMs: 10, maxWaitMs: 50, reconcileRetryMs: 100,
    now: clock.now, schedule: clock.schedule,
    run: async () => {}, reconcile: noReconciliation,
    ...overrides,
  });
  return { scheduler, clock };
}

test('distinct-file burst bounds queues, active work and timers while reserving quiet-provider capacity', async () => {
  const gate = deferred();
  const starts: string[] = [];
  const { scheduler, clock } = harness({
    run: async (entry) => { starts.push(entry.provider); await gate.promise; },
    reconcile: async function* (provider) { starts.push(`${provider}:reconcile`); await gate.promise; yield; },
  });
  for (let i = 0; i < 10_000; i += 1) scheduler.enqueue(update('claude', `burst-${i}`));
  scheduler.enqueue(update('codex', 'quiet-codex'));
  scheduler.enqueue(update('gjc', 'quiet-gjc'));
  assert.equal(scheduler.diagnostics().pending, 4);
  assert.equal(scheduler.diagnostics().overflowed, 9_998);
  assert.equal(scheduler.diagnostics().reconciliationPending, 1);
  await clock.tick(10);
  assert.deepEqual(starts, ['claude:reconcile', 'codex']);
  assert.equal(scheduler.diagnostics().active, 2);
  assert.equal(clock.maximumTimers, 1);
  gate.resolve();
  await clock.tick(50);
  assert.ok(starts.indexOf('gjc') < starts.indexOf('claude'));
  assert.equal(scheduler.diagnostics().pending, 0);
  assert.equal(scheduler.diagnostics().active, 0);
  await scheduler.close();
});

test('round robin serves all providers and alternates recovery with ready live files', async () => {
  const starts: string[] = [];
  const { scheduler, clock } = harness({
    maxActive: 1, debounceMs: 0,
    run: async (entry) => { starts.push(`${entry.provider}:file`); },
    reconcile: async function* (provider) {
      for (let file = 0; file < 20; file += 1) { starts.push(`${provider}:reconcile`); yield; }
    },
  });
  for (const provider of ['claude', 'codex', 'gjc'] as const) {
    scheduler.enqueue(update(provider, 'live'));
    scheduler.requestReconciliation(provider);
  }
  await clock.tick();
  assert.deepEqual(starts.slice(0, 6), [
    'claude:reconcile', 'codex:reconcile', 'gjc:reconcile',
    'claude:file', 'codex:file', 'gjc:file',
  ]);
  for (let i = 6; i < starts.length; i += 3) {
    assert.deepEqual(starts.slice(i, i + 3), ['claude:reconcile', 'codex:reconcile', 'gjc:reconcile']);
  }
  await scheduler.close();
});

test('add wins coalescing, max wait survives a hot file, and updates during indexing produce one trailing run', async () => {
  const gate = deferred();
  const starts: Array<{ eventType: string; at: number }> = [];
  const built = harness({
    run: async (entry) => {
      starts.push({ eventType: entry.eventType, at: clock.time });
      if (starts.length === 1) await gate.promise;
    },
  });
  const clock = built.clock;
  const { scheduler } = built;
  scheduler.enqueue(update('claude', 'same'));
  for (let i = 0; i < 6; i += 1) {
    await clock.tick(8);
    scheduler.enqueue(update('claude', 'same', i === 2 ? 'add' : 'change'));
  }
  await clock.tick(2);
  assert.deepEqual(starts, [{ eventType: 'add', at: 50 }]);
  for (let i = 0; i < 100; i += 1) scheduler.enqueue(update('claude', 'same'));
  await clock.tick(100);
  assert.equal(starts.length, 1);
  assert.equal(scheduler.diagnostics().pending, 1);
  assert.equal(scheduler.diagnostics().active, 1);
  gate.resolve();
  await clock.tick();
  assert.deepEqual(starts, [{ eventType: 'add', at: 50 }, { eventType: 'change', at: 150 }]);
  await scheduler.close();
});

test('identical paths in different providers remain independent and each provider is single flight', async () => {
  const gates = [deferred(), deferred()];
  const starts: string[] = [];
  const { scheduler, clock } = harness({
    run: async (entry) => { starts.push(entry.provider); await gates[starts.length - 1]?.promise; },
  });
  scheduler.enqueue(update('claude', 'shared-path'));
  scheduler.enqueue(update('codex', 'shared-path'));
  await clock.tick(10);
  assert.deepEqual(starts, ['claude', 'codex']);
  scheduler.enqueue(update('claude', 'shared-path'));
  await clock.tick(50);
  assert.equal(starts.length, 2);
  gates.forEach((gate) => gate.resolve());
  await clock.tick();
  assert.deepEqual(starts, ['claude', 'codex', 'claude']);
  await scheduler.close();
});

test('file and reconciliation errors retry without spinning or blocking healthy providers', async () => {
  let recovered = 0;
  let attempts = 0;
  const starts: string[] = [];
  const { scheduler, clock } = harness({
    run: async (entry) => { starts.push(entry.provider); if (entry.provider === 'claude') throw new Error('private-path'); },
    reconcile: async function* () {
      attempts += 1;
      if (attempts === 1) throw new Error('private-token');
      recovered += 1;
      yield;
    },
  });
  scheduler.enqueue(update('claude', 'broken'));
  scheduler.enqueue(update('codex', 'healthy'));
  await clock.tick(10);
  assert.deepEqual(starts, ['claude', 'codex']);
  assert.equal(attempts, 1);
  assert.equal(scheduler.diagnostics().failures, 2);
  assert.equal(scheduler.diagnostics().reconciliationPending, 1);
  await clock.tick(99);
  assert.equal(attempts, 1);
  await clock.tick(1);
  assert.equal(recovered, 1);
  assert.equal(scheduler.diagnostics().reconciliationPending, 0);
  assert.ok(!JSON.stringify(scheduler.diagnostics()).includes('private'));
  await scheduler.close();
});

test('overflow during reconciliation survives completion and is recovered in a second pass', async () => {
  const gate = deferred();
  let passes = 0;
  const { scheduler, clock } = harness({
    reconcile: async function* () { passes += 1; if (passes === 1) await gate.promise; yield; },
  });
  scheduler.requestReconciliation('gjc');
  await clock.tick();
  for (let i = 0; i < 100; i += 1) scheduler.enqueue(update('gjc', `later-${i}`));
  assert.equal(scheduler.diagnostics().pending, 2);
  gate.resolve();
  await clock.tick(10);
  assert.equal(passes, 1);
  assert.equal(scheduler.diagnostics().reconciliationPending, 1);
  await clock.tick(90);
  assert.equal(passes, 2);
  assert.equal(scheduler.diagnostics().reconciliationPending, 0);
  await scheduler.close();
});

test('aborted watcher generations cannot index queued files and recovery uses the scheduler lifetime', async () => {
  const stale = new AbortController();
  const recovered: boolean[] = [];
  const starts: string[] = [];
  const { scheduler, clock } = harness({
    run: async (entry) => { starts.push(entry.filePath); },
    reconcile: async function* (_provider, signal) { recovered.push(signal.aborted); yield; },
  });
  scheduler.enqueue({ ...update('gjc', 'stale'), signal: stale.signal });
  stale.abort();
  scheduler.enqueue({ ...update('gjc', 'already-aborted'), signal: stale.signal });
  await clock.tick(10);
  assert.deepEqual(starts, []);
  assert.deepEqual(recovered, [false]);
  assert.equal(scheduler.diagnostics().failures, 0);
  await scheduler.close();
});

test('fresh same-file event replaces an expired queued generation', async () => {
  const stale = new AbortController();
  const fresh = new AbortController();
  let indexed = 0;
  const { scheduler, clock } = harness({ run: async (_entry, signal) => { assert.equal(signal.aborted, false); indexed += 1; } });
  scheduler.enqueue({ ...update('gjc', 'same'), signal: stale.signal });
  stale.abort();
  scheduler.enqueue({ ...update('gjc', 'same'), signal: fresh.signal });
  await clock.tick(10);
  assert.equal(indexed, 1);
  assert.equal(scheduler.diagnostics().reconciliationPending, 0);
  await scheduler.close();
});

test('paused startup stays bounded and only starts indexing after its owner resumes', async () => {
  let calls = 0;
  const { scheduler, clock } = harness({ paused: true, run: async () => { calls += 1; } });
  for (let i = 0; i < 1_000; i += 1) scheduler.enqueue(update('gjc', `startup-${i}`));
  await clock.tick(100);
  assert.equal(calls, 0);
  assert.equal(clock.timers.size, 0);
  assert.equal(scheduler.diagnostics().pending, 2);
  scheduler.start();
  await clock.tick();
  assert.equal(calls, 2);
  await scheduler.close();
});

test('shutdown cancels and drains active indexing, closes recovery iterators and prevents later work', async () => {
  const gate = deferred();
  const signals: AbortSignal[] = [];
  let iteratorClosed = false;
  let publications = 0;
  const { scheduler, clock } = harness({
    run: async (_entry, signal) => { signals.push(signal); await gate.promise; if (!signal.aborted) publications += 1; },
    reconcile: async function* (_provider, signal) {
      try { signals.push(signal); yield; await gate.promise; }
      finally { iteratorClosed = true; }
    },
  });
  scheduler.enqueue(update('claude', 'active'));
  await clock.tick(10);
  scheduler.requestReconciliation('gjc');
  await clock.tick();
  scheduler.enqueue(update('codex', 'never'));
  const closing = scheduler.close();
  assert.equal(scheduler.close(), closing);
  assert.ok(signals.every((signal) => signal.aborted));
  assert.equal(clock.timers.size, 0);
  gate.resolve();
  await closing;
  scheduler.enqueue(update('claude', 'after-close'));
  scheduler.requestReconciliation('codex');
  scheduler.start();
  await clock.tick(1_000);
  assert.equal(iteratorClosed, true);
  assert.equal(publications, 0);
  assert.equal(scheduler.diagnostics().active, 0);
  assert.equal(scheduler.diagnostics().pending, 0);
  assert.equal(scheduler.diagnostics().reconciliationPending, 0);
  assert.equal(clock.timers.size, 0);
});


test('incremental errors retry incrementally and never silently turn into historical gap scans', async () => {
  const modes: string[] = [];
  const { scheduler, clock } = harness({
    reconcile: async function* (_provider, _signal, mode) {
      modes.push(mode);
      if (modes.length === 1) throw new Error('temporary incremental failure');
      yield;
    },
  });
  scheduler.requestReconciliation('gjc', 'incremental');
  await clock.tick();
  await clock.tick(100);
  assert.deepEqual(modes, ['incremental', 'incremental']);
  await scheduler.close();
});

test('overflow upgrades pending incremental work and periodic ticks cannot downgrade it', async () => {
  const modes: string[] = [];
  const { scheduler, clock } = harness({
    reconcile: async function* (_provider, _signal, mode) { modes.push(mode); yield; },
  });
  scheduler.requestReconciliation('gjc', 'incremental');
  for (let i = 0; i < 10; i += 1) scheduler.enqueue(update('gjc', `overflow-${i}`));
  scheduler.requestReconciliation('gjc', 'incremental');
  await clock.tick(10);
  assert.deepEqual(modes, ['gap']);
  await scheduler.close();
});

test('a gap during an active incremental pass remains a separate cursor-independent recovery', async () => {
  const gate = deferred();
  const modes: string[] = [];
  const { scheduler, clock } = harness({
    reconcile: async function* (_provider, _signal, mode) {
      modes.push(mode);
      if (mode === 'incremental') await gate.promise;
      yield;
    },
  });
  scheduler.requestReconciliation('gjc', 'incremental');
  await clock.tick();
  scheduler.requestReconciliation('gjc');
  scheduler.requestReconciliation('gjc', 'incremental');
  gate.resolve();
  await clock.tick(100);
  assert.deepEqual(modes, ['incremental', 'gap']);
  await scheduler.close();
});
