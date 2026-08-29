import assert from 'node:assert/strict';
import test from 'node:test';

import {
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
