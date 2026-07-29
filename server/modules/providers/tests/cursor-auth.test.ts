import assert from 'node:assert/strict';
import test from 'node:test';

import spawn from 'cross-spawn';

import {
  CursorProviderAuth,
  isCursorAgentInstalled,
} from '@/modules/providers/list/cursor/cursor-auth.provider.js';
import {
  isCursorCliProcess,
  resolveCursorCliCommand,
} from '@/modules/providers/list/cursor/cursor-cli-command.js';

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

test('cursor installation probe prefers the documented agent command', () => {
  const calls: string[] = [];
  const runVersionProbe = ((command: string, args: readonly string[]) => {
    calls.push(`${command} ${args.join(' ')}`);
    if (command === 'agent' && args[0] === '--version') {
      return probeResult({ stdout: '2026.07.23' });
    }
    if (command === 'agent' && args[0] === '--help') {
      return probeResult({ stdout: 'Start the Cursor Agent' });
    }
    return probeResult({ status: 1 });
  }) as typeof spawn.sync;

  assert.equal(resolveCursorCliCommand(runVersionProbe), 'agent');
  assert.equal(isCursorAgentInstalled(runVersionProbe), true);
  assert.deepEqual(calls.slice(0, 2), ['agent --version', 'agent --help']);
});

test('cursor installation probe retains the legacy cursor-agent alias', () => {
  const runVersionProbe = ((command: string, args: readonly string[]) => {
    if (command === 'agent' && args[0] === '--version') {
      return probeResult({ stdout: 'unrelated-agent' });
    }
    if (command === 'agent' && args[0] === '--help') {
      return probeResult({ stdout: 'Generic automation agent' });
    }
    return command === 'cursor-agent'
      ? probeResult({ stdout: '1.0.0' })
      : probeResult({ status: 1 });
  }) as typeof spawn.sync;

  assert.equal(resolveCursorCliCommand(runVersionProbe), 'cursor-agent');
});

test('cursor installation probe rejects unsuccessful command candidates', () => {
  assert.equal(isCursorAgentInstalled(probe(probeResult({ status: 1 }))), false);
});

test('Cursor process recognition accepts the official launcher and rejects generic agent tools', () => {
  assert.equal(isCursorCliProcess({
    comm: 'MainThread',
    args: '/home/user/.local/bin/agent --use-system-ca /home/user/.local/share/cursor-agent/versions/current/index.js',
  }), true);
  assert.equal(isCursorCliProcess({
    comm: 'node',
    args: 'node /usr/local/bin/agent run background-task',
  }), false);
  assert.equal(isCursorCliProcess({
    comm: 'agent',
    args: 'agent run background-task',
  }), false);
  assert.equal(isCursorCliProcess({
    comm: 'cursor-agent',
    args: 'cursor-agent --resume=session-id',
  }), true);
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
