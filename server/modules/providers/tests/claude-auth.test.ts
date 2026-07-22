import assert from 'node:assert/strict';
import test from 'node:test';

import spawn from 'cross-spawn';

import {
  ClaudeProviderAuth,
  hasClaudeKeychainCredentials,
} from '@/modules/providers/list/claude/claude-auth.provider.js';

const probeResult = (
  overrides: Record<string, unknown> = {},
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

test('Claude keychain probe accepts the current macOS credential service', () => {
  assert.equal(hasClaudeKeychainCredentials('darwin', probe(probeResult())), true);
});

test('Claude keychain probe rejects missing items and non-macOS hosts', () => {
  const missing = probe(probeResult({ status: 44 }));
  assert.equal(hasClaudeKeychainCredentials('darwin', missing), false);
  assert.equal(hasClaudeKeychainCredentials('linux', probe(probeResult())), false);
});

test('Claude provider reports a macOS Keychain login without reading its secret', async () => {
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  const keychainProbe = ((command: string, args: readonly string[]) => {
    calls.push({ command, args });
    return probeResult();
  }) as typeof spawn.sync;
  const provider = new ClaudeProviderAuth({
    platform: 'darwin',
    runVersionProbe: probe(probeResult()),
    runKeychainProbe: keychainProbe,
  });

  assert.deepEqual(await provider.getStatus(), {
    installed: true,
    provider: 'claude',
    authenticated: true,
    email: 'Authenticated',
    method: 'keychain',
    error: undefined,
  });
  assert.deepEqual(calls, [{
    command: '/usr/bin/security',
    args: ['find-generic-password', '-s', 'Claude Code-credentials'],
  }]);
});
