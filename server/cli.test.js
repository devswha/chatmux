import assert from 'node:assert/strict';
import test from 'node:test';

import { buildInstallArgs, parseArgs } from './cli.js';

test('global install options before the command are retained', () => {
  const parsed = parseArgs(['--port', '8080', '--host', '127.0.0.1', '--yes', 'install']);
  assert.deepEqual(
    parsed,
    {
      command: 'install',
      options: { serverPort: '8080', host: '127.0.0.1', yes: true },
      remainingArgs: [],
    },
  );
  assert.deepEqual(buildInstallArgs(parsed.options, parsed.remainingArgs), ['--yes', '--port=8080']);
});

test('options requiring values reject a following command', () => {
  assert.throws(() => parseArgs(['--port', 'install']), /--port requires a value/);
});

test('fleet commands preserve their local operator arguments', () => {
  const parsed = parseArgs(['fleet', 'revoke', '10000000-0000-4000-8000-000000000001']);
  assert.equal(parsed.command, 'fleet');
  assert.deepEqual(parsed.remainingArgs, ['revoke', '10000000-0000-4000-8000-000000000001']);
});
