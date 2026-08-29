import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const fixturePaths = [
  'scripts/cua/run-fixture.ts',
  'scripts/cua/fleet-process-lifecycle.ts',
  'server/modules/providers/tests/support/tmux-e2e-harness.ts',
  'server/modules/providers/tests/support/tmux-e2e-types.ts',
  'server/modules/providers/tests/support/tmux-event-log.ts',
  'server/modules/providers/tests/support/tmux-fake-agent.ts',
  'server/modules/providers/tests/support/tmux-fleet-harness.ts',
  'server/modules/providers/tests/support/tmux-fleet-node.ts',
  'server/modules/providers/tests/support/tmux-harness-utils.ts',
  'server/modules/providers/tests/support/tmux-owned-server.ts',
  'server/modules/providers/tests/support/tmux-single-harness.ts',
] as const;

test('fixture modules remain cohesive and use event-driven waits', async () => {
  // Given: every module in the touched fixture path.
  const sources = await Promise.all(fixturePaths.map(async (filePath) => ({
    filePath,
    source: await readFile(path.resolve(filePath), 'utf8'),
  })));
  // When: pure LOC and prohibited fixed-delay APIs are inspected.
  const results = sources.map(({ filePath, source }) => ({
    filePath,
    pureLoc: source.split('\n').filter((line) => {
      const trimmed = line.trim();
      return trimmed !== '' && !trimmed.startsWith('//') && !trimmed.startsWith('#');
    }).length,
    hasFixedDelay: new RegExp(['delay\\((?:25|200)\\)', 'setTimeout as ', 'delay', 'while \\(Date\\.now'].join('|')).test(source),
  }));
  // Then: no facade/module is oversized and no fixture polling API remains.
  assert.deepEqual(results.filter(({ pureLoc }) => pureLoc > 250), []);
  assert.deepEqual(results.filter(({ hasFixedDelay }) => hasFixedDelay), []);
});
