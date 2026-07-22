import assert from 'node:assert/strict';
import test from 'node:test';

import spawn from 'cross-spawn';

import {
  CursorProviderAuth,
  isCursorAgentInstalled,
} from '@/modules/providers/list/cursor/cursor-auth.provider.js';

const probeResult = (
  overrides: Record<string, unknown>,
): ReturnType<typeof spawn.sync> => ({
  pid: 123,
  output: [null, null, null],
  stdout: null,
  stderr: null,
  status: 0,
  signal: null,
  ...overrides,
} as unknown as ReturnType<typeof spawn.sync>);

const probe = (result: ReturnType<typeof spawn.sync>) => (
  (() => result) as typeof spawn.sync
);

test('cursor installation probe accepts a successful version command', () => {
  assert.equal(isCursorAgentInstalled(probe(probeResult({ status: 0 }))), true);
});

test('cursor installation probe rejects a non-zero version command', () => {
  assert.equal(isCursorAgentInstalled(probe(probeResult({ status: 1 }))), false);
});

test('cursor installation probe rejects ENOENT and reports the provider as missing', async () => {
  const missing = Object.assign(new Error('spawnSync cursor-agent ENOENT'), { code: 'ENOENT' });
  const runVersionProbe = probe(probeResult({ error: missing, status: null }));

  assert.equal(isCursorAgentInstalled(runVersionProbe), false);
  assert.deepEqual(await new CursorProviderAuth(runVersionProbe).getStatus(), {
    installed: false,
    provider: 'cursor',
    authenticated: false,
    email: null,
    method: null,
    error: 'Cursor CLI is not installed',
  });
});
