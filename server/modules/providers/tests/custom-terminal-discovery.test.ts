import assert from 'node:assert/strict';
import test from 'node:test';

import type { HostDiscoverySnapshot } from '../services/host-discovery-snapshot.service.js';
import type { CustomProcessRecordReader } from '../services/external-cli-sessions/custom-terminal-agents.js';
import { createExternalCliSessionDiscovery } from '../services/external-cli-sessions/discovery.js';
import { createExternalCliSessionInferenceRetryBackoff } from '../services/external-cli-sessions/contracts-and-resume.js';
import { applyInferredProviderSessionIds } from '../services/external-cli-sessions/provider-runtime-inference.js';
import { assertFreshExternalTmuxTarget } from '../services/tmux-fresh-verifier.service.js';
import { tmuxPaneIdentityKey } from '../../../../shared/tmux.js';

const tmux = { socketPath: '/tmp/chatmux-custom-discovery-fixture.sock', sessionId: '$1', windowId: '@1', paneId: '%1' };
const env = { CHATMUX_CUSTOM_TERMINAL_AGENTS: '[{"command":"my-agent","argv":["chat"]}]' };

function fixture() {
  // Metadata may read this test worker's own process start time, never a user agent.
  const pid = process.pid;
  const snapshot: HostDiscoverySnapshot = {
    ok: true, capturedAtMs: 100,
    panes: [{ name: 'custom-fixture', tmux, pid, command: 'my-agent', cwd: '/same/cwd' }],
    processes: [{ pid, ppid: process.ppid, comm: 'my-agent', args: 'my-agent chat' }],
  };
  const fields = Array<string>(50).fill('0');
  fields[0] = 'S';
  fields[1] = String(process.ppid);
  fields[2] = fields[3] = fields[5] = String(pid);
  fields[4] = '34816';
  fields[19] = '1234';
  let cmdline = '/usr/local/bin/my-agent\0chat\0';
  const reads: string[] = [];
  const readProcessRecord: CustomProcessRecordReader = async (target, record) => {
    assert.equal(target, pid);
    reads.push(record);
    return record === 'stat' ? `${pid} (my-agent) ${fields.join(' ')}\n` : cmdline;
  };
  return { pid, snapshot, reads, readProcessRecord, changeArgs: (value: string) => { cmdline = value; } };
}

test('both cached and fresh host discovery retain terminal-only identity without native inference', async () => {
  const f = fixture();
  let cachedScans = 0;
  let freshScans = 0;
  const discovery = createExternalCliSessionDiscovery({
    hostSnapshot: async () => { cachedScans += 1; return f.snapshot; },
    freshHostSnapshot: async () => { freshScans += 1; return f.snapshot; },
    customTerminalAgents: { env, platform: 'linux', readProcessRecord: f.readProcessRecord },
    commandRunner: async () => assert.fail('shared host snapshot must avoid tmux/process enumeration'),
  });
  const first = await discovery.getExternalCliSessionsDetailed();
  assert.equal(first.ok, true);
  assert.equal(first.sessions.length, 1);
  const row = first.sessions[0];
  assert.equal(row.kind, 'shell');
  assert.equal(row.agentPid, f.pid);
  assert.equal(typeof row.startedAtMs, 'number');
  assert.deepEqual(row.tmux, tmux);
  assert.equal(row.providerSessionId, undefined);
  assert.equal(row.binding, undefined);
  assert.deepEqual(createExternalCliSessionInferenceRetryBackoff().attemptableSessions(first.sessions), []);
  assert.deepEqual(applyInferredProviderSessionIds(first.sessions, new Map([[tmuxPaneIdentityKey(tmux), 'guessed-session']])), first.sessions);
  assert.equal(await discovery.getExternalCliSessionsDetailed(), first);
  assert.equal(cachedScans, 1);
  assert.equal(f.reads.length, 3);

  f.changeArgs('/usr/local/bin/my-agent\0chatty\0');
  const fresh = await discovery.getExternalCliSessionsDetailedFresh();
  assert.equal(freshScans, 1);
  assert.equal(fresh.ok, true);
  assert.equal(fresh.sessions[0].kind, 'shell');
  assert.equal(fresh.sessions[0].agentPid, undefined);
  assert.equal(fresh.sessions[0].startedAtMs, undefined);
  assert.equal((await discovery.getExternalCliSessionsDetailed()).sessions[0].agentPid, f.pid);

  await assert.rejects(assertFreshExternalTmuxTarget(tmux, { pid: f.pid, startedAtMs: row.startedAtMs }, {
    scan: async () => first.sessions,
    assertPaneIdentity: async () => assert.fail('a custom shell must not mint a provider action target'),
  }), { code: 'TMUX_PROCESS_GENERATION_MISMATCH' });
});

test('command-runner discovery also applies owner configuration without launching configured commands', async () => {
  const f = fixture();
  const commands: string[] = [];
  const discovery = createExternalCliSessionDiscovery({
    commandRunner: async (command, args) => {
      commands.push(command);
      if (command === 'tmux') {
        assert.deepEqual(args.slice(0, 3), ['list-panes', '-a', '-F']);
        return `${tmux.socketPath}\t$1\t@1\t%1\tcustom-fixture\t${f.pid}\tmy-agent\t\t/same/cwd\t\t\n`;
      }
      assert.equal(command, 'ps');
      assert.deepEqual(args, ['-eo', 'pid,ppid,comm,args']);
      return `${f.pid} ${process.ppid} my-agent my-agent chat\n`;
    },
    customTerminalAgents: { env, platform: 'linux', readProcessRecord: f.readProcessRecord },
  });
  const result = await discovery.getExternalCliSessionsDetailedFresh();
  assert.equal(result.ok, true);
  assert.equal(result.sessions[0].kind, 'shell');
  assert.equal(result.sessions[0].agentPid, f.pid);
  assert.deepEqual(commands, ['tmux', 'ps']);
});

test('failed custom evidence and malformed configuration leave successful ordinary discovery intact', async () => {
  for (const customTerminalAgents of [
    { env, platform: 'linux' as const, readProcessRecord: async () => { throw new Error('private diagnostic'); } },
    { env: { CHATMUX_CUSTOM_TERMINAL_AGENTS: 'invalid' }, platform: 'linux' as const, readProcessRecord: async () => assert.fail('invalid config must not read') },
  ]) {
    const f = fixture();
    const discovery = createExternalCliSessionDiscovery({ hostSnapshot: async () => f.snapshot, customTerminalAgents });
    assert.deepEqual(await discovery.getExternalCliSessionsDetailed(), {
      ok: true, sessions: [{ tmuxName: 'custom-fixture', tmux, kind: 'shell', cwd: '/same/cwd' }],
    });
  }
  const discovery = createExternalCliSessionDiscovery({
    hostSnapshot: async () => ({ ...fixture().snapshot, ok: false }),
    customTerminalAgents: { env, platform: 'linux', readProcessRecord: async () => assert.fail('unavailable snapshot must not read') },
  });
  assert.deepEqual(await discovery.getExternalCliSessionsDetailed(), { ok: false, sessions: [] });
});

test('shell and SSH rows cannot inherit either inferred or process-observed provider IDs', () => {
  for (const kind of ['shell', 'ssh'] as const) {
    const row = { tmuxName: 'terminal', tmux, kind, agentPid: 100, startedAtMs: 1000 };
    const key = tmuxPaneIdentityKey(tmux);
    for (const authoritative of [new Set<string>(), new Set([key])]) {
      const stale = { ...row, providerSessionId: 'stale-native-id', binding: 'observed' as const };
      assert.deepEqual(applyInferredProviderSessionIds([stale], new Map([[key, 'other-native-id']]), authoritative), [row]);
    }
  }
});
