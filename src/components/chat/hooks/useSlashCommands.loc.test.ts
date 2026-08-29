import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const PURE_SOURCE_LINE = /^(?!\s*$)(?!\s*(?:\/\/|#|--))/;

test('Given the split slash command modules, when source size is measured, then each stays reviewable', async () => {
  // Given
  const paths = ['./useSlashCommands.ts', './slashCommandMenu.ts'] as const;

  // When
  const sources = await Promise.all(paths.map(async (path) => ({
    path,
    source: await readFile(new URL(path, import.meta.url), 'utf8'),
  })));

  // Then
  for (const { path, source } of sources) {
    const pureLines = source.split('\n').filter((line) => PURE_SOURCE_LINE.test(line)).length;
    assert.ok(pureLines <= 250, `${path} has ${pureLines} pure lines`);
  }
});
