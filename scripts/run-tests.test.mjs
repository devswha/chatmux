import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import * as runner from './run-tests.mjs';

const EXPECTED_REAL_RESOURCE_TESTS = [
  'server/gjc-core-host.test.ts',
  'server/modules/fleet/tests/task-12-remote-terminal.live.test.ts',
  'server/modules/providers/tests/tmux-runtime.e2e.test.ts',
  'server/modules/providers/tests/tmux-fleet.e2e.test.ts',
  'server/modules/providers/tests/tmux-fleet-lifecycle.e2e.test.ts',
  'server/modules/fleet/tests/task-23-chat-approval.e2e.test.ts',
  'server/modules/fleet/tests/task-23-discovery-reads.e2e.test.ts',
  'server/modules/fleet/tests/task-23-recovery-isolation.e2e.test.ts',
  'server/modules/fleet/tests/task-23-terminal-spawn-terminate.e2e.test.ts',
];

test('server-side discovery includes release verification tests in scripts', async () => {
  const { serverTests } = await runner.discoverTests();
  assert.ok(serverTests.includes(path.join('scripts', 'release', 'verify-db-rollback-compatibility.test.ts')));
});

test('real tmux and PTY files form the exact serial resource partition', () => {
  assert.deepEqual(runner.REAL_RESOURCE_TESTS, EXPECTED_REAL_RESOURCE_TESTS);
});

test('server partition assigns every discovered test exactly once', async () => {
  // Given
  const { serverTests } = await runner.discoverTests();

  // When
  const partition = runner.partitionServerTests(serverTests);
  const assigned = [...partition.regular, ...partition.realResources];

  // Then
  assert.equal(assigned.length, serverTests.length);
  assert.equal(new Set(assigned).size, assigned.length);
  assert.deepEqual([...assigned].sort(), serverTests);
});

test('server partition rejects duplicate or missing resource inventory', () => {
  assert.throws(() => runner.partitionServerTests([...EXPECTED_REAL_RESOURCE_TESTS, EXPECTED_REAL_RESOURCE_TESTS[0]]));
  assert.throws(() => runner.partitionServerTests(EXPECTED_REAL_RESOURCE_TESTS.slice(1)));
});
