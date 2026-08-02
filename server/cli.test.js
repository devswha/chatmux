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
