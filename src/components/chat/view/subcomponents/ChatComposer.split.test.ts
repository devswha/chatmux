import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const PURE_SOURCE_LINE = /^(?!\s*$)(?!\s*(?:\/\/|#|--))/;

const COMPOSER_MODULES = [
  './ChatComposer.tsx',
  './ChatComposerControls.tsx',
  './ChatComposerFeedback.tsx',
  './ChatComposerInputSurface.tsx',
  './chatComposerTypes.ts',
] as const;

test('Given the split composer modules, when source size is measured, then each cohesive concern stays reviewable', async () => {
  // Given
  const sources = await Promise.all(COMPOSER_MODULES.map(async (path) => ({
    path,
    source: await readFile(new URL(path, import.meta.url), 'utf8'),
  })));

  // When
  const measurements = sources.map(({ path, source }) => ({
    path,
    pureLines: source.split('\n').filter((line) => PURE_SOURCE_LINE.test(line)).length,
  }));

  // Then
  for (const { path, pureLines } of measurements) {
    assert.ok(pureLines <= 250, `${path} has ${pureLines} pure lines`);
  }
});
