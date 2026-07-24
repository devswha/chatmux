import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  builtinRelayEnabled,
  builtinSpawn,
  resolveSpawnCwd,
  type TmuxRunner,
} from '@/modules/providers/services/builtin-relay.service.js';

// Tower-unreachable fallback for creating a new GJC session. Relay and
// termination are exact-pane actions covered by tmux-pane-actions tests.

type Call = { args: string[]; stdin?: string };

function runner(script: (call: Call) => { code: number; output: string }): { run: TmuxRunner; calls: Call[] } {
  const calls: Call[] = [];
  const run: TmuxRunner = async (args, stdin) => {
    const call = { args, ...(stdin !== undefined ? { stdin } : {}) };
    calls.push(call);
    return script(call);
  };
  return { run, calls };
}

const ok = { code: 0, output: '' };


test('builtinSpawn: validated cwd, duplicate → conflict, then new-session + gjc boot', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'relay-home-'));
  mkdirSync(path.join(home, 'workspace', 'proj'), { recursive: true });

  const dup = runner((call) => (call.args[0] === 'has-session' ? ok : { code: 1, output: 'x' }));
  const conflict = await builtinSpawn('taken', '~/workspace/proj', { run: dup.run, home });
  assert.equal(conflict.conflict, true);

  const fresh = runner((call) => (call.args[0] === 'has-session' ? { code: 1, output: '' } : ok));
  const created = await builtinSpawn('newone', '~/workspace/proj', { run: fresh.run, home });
  assert.equal(created.ok, true);
  assert.deepEqual(fresh.calls[1].args.slice(0, 5), ['new-session', '-d', '-s', 'newone', '-c']);
  assert.ok(fresh.calls[1].args[5].endsWith(`${path.sep}workspace${path.sep}proj`));
  assert.deepEqual(fresh.calls[2].args, ['send-keys', '-t', '=newone:', 'gjc', 'Enter']);
});

test('builtinSpawn: company* reserved and non-home cwd fail closed', async () => {
  const noRun = (async () => {
    throw new Error('must not run');
  }) as TmuxRunner;
  const reserved = await builtinSpawn('company-x', '~/workspace', { run: noRun });
  assert.equal(reserved.ok, false);

  const home = mkdtempSync(path.join(tmpdir(), 'relay-home-'));
  const outside = await builtinSpawn('okname', '/etc', { run: noRun, home });
  assert.equal(outside.ok, false);
  assert.ok(outside.detail.includes('홈 아래 실존 디렉터리만'));
});

test('resolveSpawnCwd: expanduser + realpath containment + must be a directory', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'relay-home-'));
  mkdirSync(path.join(home, 'workspace'));
  writeFileSync(path.join(home, 'afile'), '');
  assert.ok((await resolveSpawnCwd('~/workspace', home))?.endsWith(`${path.sep}workspace`));
  assert.ok(await resolveSpawnCwd('~', home), 'home itself is allowed');
  assert.equal(await resolveSpawnCwd('~/afile', home), null, 'files are not workdirs');
  assert.equal(await resolveSpawnCwd('~/missing', home), null);
  assert.equal(await resolveSpawnCwd('/etc', home), null, 'outside home');
  assert.equal(await resolveSpawnCwd('relative/path', home), null, 'must be absolute after expansion');
});


test('builtinRelayEnabled: on by default, CHATMUX_BUILTIN_RELAY=0 restores tower-only mode', () => {
  assert.equal(builtinRelayEnabled({}), true);
  assert.equal(builtinRelayEnabled({ CHATMUX_BUILTIN_RELAY: '0' }), false);
  assert.equal(builtinRelayEnabled({ CHATMUX_BUILTIN_RELAY: '1' }), true);
});
