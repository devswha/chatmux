import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { PI_AGENT_ROOT_DIRS } from '@/modules/providers/list/gjc/gjc-session-synchronizer.provider.js';

/**
 * Regression lock for the omo mis-attribution: the root lookup used to be
 * `provider === 'omp' ? '.omp' : '.gjc'`, so adding omo to the union silently
 * pointed it at gjc's transcripts. 632 gjc sessions were indexed as omo and the
 * whole suite still passed, because a ternary else branch is not a type error.
 */
test('every pi provider reads its own agent home, and no two share one', () => {
  assert.deepEqual(PI_AGENT_ROOT_DIRS, {
    gjc: path.join(os.homedir(), '.gjc', 'agent'),
    omp: path.join(os.homedir(), '.omp', 'agent'),
    omo: path.join(os.homedir(), '.omo', 'agent'),
  });

  const roots = Object.values(PI_AGENT_ROOT_DIRS);
  assert.equal(new Set(roots).size, roots.length, 'two providers resolve to the same root');

  for (const [provider, root] of Object.entries(PI_AGENT_ROOT_DIRS)) {
    assert.ok(
      root.includes(`/.${provider}/`),
      `${provider} must read ~/.${provider}, got ${root}`,
    );
  }
});
