import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const PURE_SOURCE_LINE = /^(?!\s*$)(?!\s*(?:\/\/|#|--))/;

const PERSISTENCE_MODULES = [
  './persistedHostState.ts',
  './persistedHostStateContracts.ts',
  './persistedStateParsing.ts',
  './persistedQueuedDraft.ts',
  './persistedSessionOrder.ts',
  './persistedHostMigration.ts',
] as const;

test('Given persisted host state modules, when source size is measured, then each stays reviewable', async () => {
  // Given / When
  const sources = await Promise.all(PERSISTENCE_MODULES.map(async (path) => ({
    path,
    source: await readFile(new URL(path, import.meta.url), 'utf8'),
  })));

  // Then
  for (const { path, source } of sources) {
    const pureLines = source.split('\n').filter((line) => PURE_SOURCE_LINE.test(line)).length;
    assert.ok(pureLines <= 250, `${path} has ${pureLines} pure lines`);
  }
});
