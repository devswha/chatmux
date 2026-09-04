import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

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

test('server test workers use an initialized private database and preserve an ambient database', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'chatmux-runner-isolation-'));
  const ambient = path.join(directory, 'operator.db');
  const fixture = path.join(directory, 'database.test.mjs');
  const marker = path.join(directory, 'executed');
  try {
    await writeFile(ambient, 'operator database must stay untouched');
    await writeFile(fixture, `import assert from 'node:assert/strict';
      const { getConnection } = await import(${JSON.stringify(new URL('../server/modules/database/connection.ts', import.meta.url).href)});
      const db = getConnection();
      assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = 'sessions'").get());
      db.exec('CREATE TABLE fixture_only (value TEXT)');
      const {writeFileSync} = await import('node:fs');
      writeFileSync(${JSON.stringify(marker)}, process.env.DATABASE_PATH);`);
    const source = `const {runTests} = await import(${JSON.stringify(new URL('./run-tests.mjs', import.meta.url).href)});
      runTests('isolated fixture', [${JSON.stringify(fixture)}], {tsconfig:'server/tsconfig.json'});`;
    const environment = { ...process.env, DATABASE_PATH: ambient };
    delete environment.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', source], {
      env: environment, encoding: 'utf8', timeout: 20_000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.notEqual(await readFile(marker, 'utf8'), ambient, 'the fixture must actually execute against its private database');
    assert.equal(await readFile(ambient, 'utf8'), 'operator database must stay untouched');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('shared fleet contracts are executed by the canonical test inventory', async () => {
  const { serverTests } = await runner.discoverTests();
  assert.ok(serverTests.includes(path.join('shared', 'fleet.test.ts')));
  assert.ok(serverTests.includes(path.join('shared', 'fleet-completion.test.ts')));
  assert.ok(serverTests.includes(path.join('scripts', 'verify-owner.test.mjs')));
  assert.ok(serverTests.includes(path.join('scripts', 'run-tests.test.mjs')));
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
