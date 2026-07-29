import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import test from 'node:test';

(globalThis as typeof globalThis & { require: NodeRequire }).require = createRequire(import.meta.url);
const { default: tailwindConfig } = await import('../tailwind.config.js');

test('app sans and legacy serif utilities use one Hangul-capable font stack', () => {
  const fontFamily = tailwindConfig.theme?.extend?.fontFamily as Record<string, string[]> | undefined;

  assert.ok(fontFamily);
  assert.deepEqual(fontFamily.serif, fontFamily.sans);
  assert.equal(fontFamily.sans[0], '"Pretendard Variable"');
});
