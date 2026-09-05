import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

import { scanStateDb, sessionsDb } from '@/modules/database/index.js';
import { GjcSessionSynchronizer } from '@/modules/providers/list/gjc/gjc-session-synchronizer.provider.js';
import { reconcileSessionIndexFiles } from '@/modules/providers/services/session-indexing-reconciliation.js';
import { createSessionIndexingScheduler } from '@/modules/providers/services/session-indexing-scheduler.js';
import type { LLMProvider } from '@/shared/types.js';

async function temp(t: test.TestContext): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'chatmux-indexing-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
async function consume(iterator: AsyncGenerator<void>): Promise<void> {
  for await (const _step of iterator) { /* The scheduler consumes one step per work slot. */ }
}
async function waitForIdle(scheduler: ReturnType<typeof createSessionIndexingScheduler>): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const state = scheduler.diagnostics();
    if (state.active === 0 && state.pending === 0 && state.reconciliationPending === 0) return;
    await delay(2);
  }
  assert.fail('indexing recovery did not settle');
}

test('recovery streams one file per step, yields to timers, and skips ignored directories and symlinks', async (t) => {
  const root = await temp(t);
  const nested = path.join(root, 'project');
  const ignored = path.join(root, 'node_modules');
  await mkdir(nested);
  await mkdir(ignored);
  await Promise.all(Array.from({ length: 100 }, (_, i) => writeFile(path.join(nested, `${i}.jsonl`), '{}')));
  await writeFile(path.join(ignored, 'ignored.jsonl'), '{}');
  await writeFile(path.join(root, 'readme.txt'), 'ignored');
  await symlink(nested, path.join(root, 'linked'));
  await symlink(path.join(nested, '0.jsonl'), path.join(root, 'linked.jsonl'));
  let indexed = 0;
  let heartbeat = 0;
  const timer = setInterval(() => { heartbeat += 1; }, 1);
  t.after(() => clearInterval(timer));
  const iterator = reconcileSessionIndexFiles({
    roots: [root, root, path.join(root, 'missing')], signal: new AbortController().signal,
    isTarget: (file) => file.endsWith('.jsonl'), index: async () => { indexed += 1; },
  });
  for (;;) {
    const before = indexed;
    const step = await iterator.next();
    assert.ok(indexed - before <= 1);
    if (step.done) break;
  }
  assert.equal(indexed, 100);
  assert.ok(heartbeat > 0, 'real event-loop timers must run during recovery');
});

test('recovery continues past file and directory failures, then reports an incomplete pass without private diagnostics', async (t) => {
  const root = await temp(t);
  await writeFile(path.join(root, 'first.jsonl'), '{}');
  await writeFile(path.join(root, 'second.jsonl'), '{}');
  const seen: string[] = [];
  const iterator = reconcileSessionIndexFiles({
    // An ordinary file used as a root produces ENOTDIR, including under root.
    roots: [path.join(root, 'first.jsonl'), root], signal: new AbortController().signal,
    isTarget: (file) => file.endsWith('.jsonl'),
    index: async (file) => {
      seen.push(path.basename(file));
      if (file.endsWith('first.jsonl')) throw new Error('private transcript credentials');
    },
  });
  await assert.rejects(consume(iterator), { message: 'Session indexing reconciliation incomplete.' });
  assert.deepEqual(seen.sort(), ['first.jsonl', 'second.jsonl']);
});

test('cancelled recovery stops before the next file and releases directory iterators', async (t) => {
  const root = await temp(t);
  await writeFile(path.join(root, 'one.jsonl'), '{}');
  await writeFile(path.join(root, 'two.jsonl'), '{}');
  const controller = new AbortController();
  let indexed = 0;
  const iterator = reconcileSessionIndexFiles({
    roots: [root], signal: controller.signal,
    isTarget: (file) => file.endsWith('.jsonl'), index: async () => { indexed += 1; },
  });
  await iterator.next();
  controller.abort();
  await assert.rejects(iterator.next(), { name: 'AbortError' });
  assert.equal(indexed, 1);
  assert.equal((await iterator.next()).done, true);
});

test('multi-provider overflow indexes every old transcript after the shared scan cursor advances, including an I/O retry', async (t) => {
  const root = await temp(t);
  const providers = ['gjc', 'omp', 'omo'] as const;
  const roots = new Map<LLMProvider, string>();
  const synchronizers = new Map<LLMProvider, GjcSessionSynchronizer>();
  const files: Array<{ provider: LLMProvider; filePath: string; id: string }> = [];
  for (const provider of providers) {
    const providerRoot = path.join(root, provider);
    roots.set(provider, providerRoot);
    await mkdir(providerRoot);
    synchronizers.set(provider, new GjcSessionSynchronizer({ provider, sessionsDir: providerRoot, additionalSessionDirs: [] }));
    for (let i = 0; i < 12; i += 1) {
      const id = `overflow-${provider}-${i}`;
      const filePath = path.join(providerRoot, `${id}.jsonl`);
      await writeFile(filePath, `${JSON.stringify({ type: 'session', id, cwd: root })}\n`);
      await utimes(filePath, new Date('2020-01-01'), new Date('2020-01-01'));
      files.push({ provider, filePath, id });
    }
  }
  let transientFailure = true;
  let active = 0;
  let maximumActive = 0;
  const index = async (provider: LLMProvider, filePath: string, signal: AbortSignal) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    try {
      if (provider === 'omp' && filePath.endsWith('-8.jsonl') && transientFailure) {
        transientFailure = false;
        throw new Error('temporary private file failure');
      }
      await synchronizers.get(provider)!.synchronizeFile(filePath, signal);
    } finally { active -= 1; }
  };
  const scheduler = createSessionIndexingScheduler({
    providers, paused: true, maxPendingPerProvider: 1, maxActive: 2,
    debounceMs: 0, reconcileRetryMs: 10,
    run: (entry, signal) => index(entry.provider, entry.filePath, signal),
    reconcile: (provider, signal) => reconcileSessionIndexFiles({
      roots: [roots.get(provider)!], signal, isTarget: (file) => file.endsWith('.jsonl'),
      index: (file) => index(provider, file, signal),
    }),
  });
  t.after(() => scheduler.close());
  for (const entry of files) scheduler.enqueue({ ...entry, eventType: 'change' });
  assert.equal(scheduler.diagnostics().pending, 3);
  assert.equal(scheduler.diagnostics().overflowed, 33);
  const cursor = new Date('2099-01-01T00:00:00.000Z');
  scanStateDb.updateLastScannedAt(cursor);
  scheduler.start();
  await waitForIdle(scheduler);
  for (const entry of files) {
    assert.equal(sessionsDb.getSessionByProviderSessionId(entry.provider, entry.id)?.jsonl_path, entry.filePath);
  }
  assert.equal(scanStateDb.getLastScannedAt()?.toISOString(), cursor.toISOString());
  assert.ok(maximumActive <= 2);
  assert.equal(scheduler.diagnostics().failures, 1);
});

test('a dropped modification to an already-scanned file is recovered by the retained next-pass obligation', async (t) => {
  const root = await temp(t);
  const early = path.join(root, 'early.jsonl');
  const later = path.join(root, 'later.jsonl');
  await writeFile(early, 'old');
  await writeFile(later, 'later');
  const indexed = new Map<string, string>();
  let first: string | null = null;
  let changed = false;
  const index = async (file: string) => {
    indexed.set(file, await readFile(file, 'utf8'));
    if (!first) first = file;
    else if (!changed && file !== first) {
      changed = true;
      await writeFile(first, 'new');
      // Fill the one-file pending queue before the event for the earlier file.
      scheduler.enqueue({ provider: 'gjc', filePath: file, eventType: 'change' });
      scheduler.enqueue({ provider: 'gjc', filePath: first, eventType: 'change' });
    }
  };
  const scheduler: ReturnType<typeof createSessionIndexingScheduler> = createSessionIndexingScheduler({
    providers: ['gjc'], maxPendingPerProvider: 1, maxActive: 1, debounceMs: 0, reconcileRetryMs: 10,
    run: (entry) => index(entry.filePath),
    reconcile: (_provider, signal) => reconcileSessionIndexFiles({ roots: [root], signal, isTarget: () => true, index }),
  });
  t.after(() => scheduler.close());
  scheduler.requestReconciliation('gjc');
  await waitForIdle(scheduler);
  assert.equal(scheduler.diagnostics().overflowed, 1);
  assert.ok(first);
  assert.equal(indexed.get(first), 'new');
});
