import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resetTmuxSpawnLaunchForTests,
  resolveTmuxSpawnLaunch,
  runsInsideSystemdUnit,
  SYSTEMD_RUN_SCOPE_ARGS,
  tmuxSpawnLaunch,
} from '@/modules/providers/services/tmux-spawn-scope.service.js';

test('only a linux process started by systemd isolates its tmux spawns', () => {
  assert.equal(runsInsideSystemdUnit({ INVOCATION_ID: 'abc' }, 'linux'), true);
  assert.equal(runsInsideSystemdUnit({}, 'linux'), false, 'an interactive shell has no invocation id');
  assert.equal(runsInsideSystemdUnit({ INVOCATION_ID: '' }, 'linux'), false);
  assert.equal(runsInsideSystemdUnit({ INVOCATION_ID: 'abc' }, 'darwin'), false);
});

test('the transient-scope launch wraps tmux; the plain launch is tmux itself', () => {
  assert.deepEqual(tmuxSpawnLaunch(true), { command: 'systemd-run', prefixArgs: [...SYSTEMD_RUN_SCOPE_ARGS, 'tmux'] });
  assert.deepEqual(tmuxSpawnLaunch(false), { command: 'tmux', prefixArgs: [] });
  assert.deepEqual([...SYSTEMD_RUN_SCOPE_ARGS], ['--user', '--scope', '--collect', '--quiet', '--']);
});

test('resolveTmuxSpawnLaunch probes systemd-run once and falls back to plain tmux when the probe fails', async () => {
  resetTmuxSpawnLaunchForTests();
  let probes = 0;
  const env = { INVOCATION_ID: 'abc' };
  const first = await resolveTmuxSpawnLaunch({ env, platform: 'linux', probe: async () => { probes += 1; return true; } });
  const second = await resolveTmuxSpawnLaunch({ env, platform: 'linux', probe: async () => { probes += 1; return false; } });
  assert.equal(first.command, 'systemd-run');
  assert.equal(second.command, 'systemd-run', 'the first probe result is cached for the process lifetime');
  assert.equal(probes, 1);

  resetTmuxSpawnLaunchForTests();
  const failed = await resolveTmuxSpawnLaunch({ env, platform: 'linux', probe: async () => { throw new Error('no bus'); } });
  assert.deepEqual(failed, { command: 'tmux', prefixArgs: [] });

  resetTmuxSpawnLaunchForTests();
  const outside = await resolveTmuxSpawnLaunch({ env: {}, platform: 'linux', probe: async () => { throw new Error('must not probe'); } });
  assert.deepEqual(outside, { command: 'tmux', prefixArgs: [] });
  resetTmuxSpawnLaunchForTests();
});
