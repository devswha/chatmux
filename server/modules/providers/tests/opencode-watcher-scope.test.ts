import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import chokidar from 'chokidar';

import { sessionWatchOptions } from '@/modules/providers/services/sessions-watcher.service.js';

for (const initialDatabase of [true, false]) {
  test(`OpenCode watches only its database and recovers replacement (initial database: ${initialDatabase})`, { timeout: 15_000 }, async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'chatmux-watch-scope-'));
    const database = path.join(root, 'opencode.db');
    await mkdir(path.join(root, 'cache', 'nested'), { recursive: true });
    await writeFile(path.join(root, 'cache', 'nested', 'cache.jsonl'), 'fixture');
    if (initialDatabase) await writeFile(database, 'fixture');
    const watcher = chokidar.watch(root, {
      ignoreInitial: true, followSymlinks: false, ...sessionWatchOptions('opencode', root),
    });
    t.after(async () => { await watcher.close(); await rm(root, { recursive: true, force: true }); });
    await once(watcher, 'ready', { signal: AbortSignal.timeout(5_000) });
    assert.ok(!Object.keys(watcher.getWatched()).some((directory) => directory.includes(`${path.sep}cache`)));
    const update = once(watcher, initialDatabase ? 'change' : 'add', { signal: AbortSignal.timeout(5_000) });
    await writeFile(database, 'updated fixture database');
    assert.equal((await update)[0], database);
    const removed = once(watcher, 'unlink', { signal: AbortSignal.timeout(5_000) });
    await unlink(database);
    assert.equal((await removed)[0], database);
    const recreated = once(watcher, 'add', { signal: AbortSignal.timeout(5_000) });
    await writeFile(database, 'replacement database');
    assert.equal((await recreated)[0], database);
    assert.ok(!Object.keys(watcher.getWatched()).some((directory) => directory.includes(`${path.sep}cache`)));
  });
}

test('directory-based providers retain recursive watching and cache exclusions', () => {
  for (const provider of ['claude', 'codex', 'cursor', 'omp', 'omo', 'gjc'] as const) {
    const options = sessionWatchOptions(provider, '/fixture/root');
    assert.equal(options.depth, 6);
    assert.ok(Array.isArray(options.ignored));
    assert.ok(options.ignored.includes('**/node_modules/**'));
  }
});
