import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseBootTimeMs,
  parseProcStatStartTicks,
  parseProcessStartTime,
  processStartMs,
} from '../services/process-start-time.service.js';

test('processStartMs returns an integer millisecond generation for a live process', async () => {
  // Given: a process the kernel tracks under /proc.
  // When: its start generation is read.
  const startedAtMs = await processStartMs(process.pid);
  // Then: the value is a wire-safe integer bounded by the current wall clock.
  assert.ok(startedAtMs !== null);
  assert.equal(Number.isSafeInteger(startedAtMs), true);
  assert.ok(startedAtMs > 0 && startedAtMs <= Date.now());
});

test('processStartMs returns null for a process that does not exist', async () => {
  // Given: a pid no live process can hold (one above the kernel's pid_max on this host).
  const { readFile } = await import('node:fs/promises');
  const pidMax = Number((await readFile('/proc/sys/kernel/pid_max', 'utf8')).trim());
  // When: its generation is read.
  // Then: absence is explicit, never an exception.
  assert.equal(await processStartMs(pidMax + 1), null);
});

test('parseProcessStartTime reads the portable ps lstart format used on macOS', () => {
  // Given: a ps lstart line.
  // Then: it parses to the exact integer millisecond, and garbage is rejected.
  assert.equal(
    parseProcessStartTime('Wed Jul 22 23:16:35 2026\n'),
    Date.parse('Wed Jul 22 23:16:35 2026'),
  );
  assert.equal(parseProcessStartTime('not a process time'), null);
});

test('processStartMs derives the generation from the immutable start tick, not the procfs inode time', async () => {
  const stat = await import('node:fs/promises').then((fs) => fs.readFile(`/proc/${process.pid}/stat`, 'utf8'));
  const ticks = parseProcStatStartTicks(stat);
  assert.ok(ticks !== null && ticks > 0);
  const derived = await processStartMs(process.pid);
  const observed = Date.now() - process.uptime() * 1000;
  assert.ok(derived !== null && Math.abs(derived - observed) < 2_000, `derived ${derived} vs observed ${observed}`);

  // The comm field may contain spaces and parentheses; fields count from the last ')'.
  const tricky = `1234 (my prog) with) parens) S 1 1 1 0 -1 4194304 0 0 0 0 0 0 0 0 20 0 1 0 987654 0 0 0`;
  assert.equal(parseProcStatStartTicks(tricky), 987654);
  assert.equal(parseProcStatStartTicks('garbage'), null);
  assert.equal(parseBootTimeMs('cpu 1 2 3\nbtime 1788146973\nprocesses 1\n'), 1_788_146_973_000);
  assert.equal(parseBootTimeMs('cpu 1 2 3\n'), null);

  const injected = await processStartMs(4242, {
    readFile: async (path) => (path === '/proc/stat' ? 'btime 1000\n' : '4242 (agent) S 1 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 250 0 0 0'),
    clockTicksPerSecond: async () => 100,
  });
  assert.equal(injected, 1_000_000 + 2_500, 'boot time plus ticks over HZ, truncated to an integer');
});

test('the ps lstart fallback runs in the C locale so a localized ps cannot break it', async () => {
  const runs: Array<{ command: string; args: readonly string[]; lcAll: string | undefined }> = [];
  const value = await processStartMs(99, {
    readFile: async () => { throw new Error('ENOENT'); },
    run: async (command, args, options) => { runs.push({ command, args, lcAll: options?.env?.LC_ALL }); return 'Wed Jul 22 23:16:35 2026\n'; },
  });
  assert.equal(value, Date.parse('Wed Jul 22 23:16:35 2026'));
  assert.deepEqual(runs.map((run) => [run.command, run.lcAll]), [['ps', 'C']]);
  assert.equal(parseProcessStartTime('수  9월  2 12:00:21 2026'), null, 'the localized form the default locale produced is unparseable, hence the forced C locale');
});
