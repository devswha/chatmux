import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { discoverTests } from './run-tests.mjs';

test('server-side discovery includes release verification tests in scripts', async () => {
  const { serverTests } = await discoverTests();
  assert.ok(serverTests.includes(path.join('scripts', 'release', 'verify-db-rollback-compatibility.test.ts')));
});
