import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createExternalCliSessionDiscovery,
} from '@/modules/providers/services/external-cli-sessions.service.js';
import {
  captureHostDiscoveryPanes,
  createHostDiscoverySnapshotSource,
  parseHostDiscoveryPanes,
  parseHostDiscoveryProcesses,
} from '@/modules/providers/services/host-discovery-snapshot.service.js';
import {
  resetHostCommandCounters,
  snapshotHostCommandCounters,
} from '@/modules/providers/services/host-command-metrics.service.js';
import {
  createLiveGjcSessionDiscovery,
} from '@/modules/providers/services/live-sessions.service.js';

const TMUX_OUTPUT = [
  '/tmp/tmux\t$1\t@1\t%1\tcodex\t100\tcodex\t\t/work\tcodex\t',
  '/tmp/tmux\t$2\t@2\t%2\tgjc\t200\tgjc\t\t/work\t\t',
].join('\n');
const PS_OUTPUT = [
  'PID PPID COMMAND COMMAND',
  '100 1 codex codex',
  '200 1 gjc gjc',
].join('\n');

test('host snapshot parses the shared tmux and process supersets', () => {
  assert.deepEqual(parseHostDiscoveryPanes(TMUX_OUTPUT).map((pane) => ({
    name: pane.name,
    paneId: pane.tmux.paneId,
    command: pane.command,
    cwd: pane.cwd,
    taggedKind: pane.taggedKind,
  })), [
    { name: 'codex', paneId: '%1', command: 'codex', cwd: '/work', taggedKind: 'codex' },
    { name: 'gjc', paneId: '%2', command: 'gjc', cwd: '/work', taggedKind: undefined },
  ]);
  assert.deepEqual(parseHostDiscoveryProcesses(PS_OUTPUT), [
    { pid: 100, ppid: 1, comm: 'codex', args: 'codex' },
    { pid: 200, ppid: 1, comm: 'gjc', args: 'gjc' },
  ]);
});

test('lightweight host probing runs tmux without spawning ps', async () => {
  const commands: string[] = [];
  const result = await captureHostDiscoveryPanes(async (command) => {
    commands.push(command);
    return TMUX_OUTPUT;
  });

  assert.equal(result.ok, true);
  assert.equal(result.panes.length, 2);
  assert.deepEqual(commands, ['tmux']);
});

test('external and GJC discovery share one in-flight tmux/ps capture', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const runner = async (command: string): Promise<string> => {
    await gate;
    return command === 'tmux' ? TMUX_OUTPUT : PS_OUTPUT;
  };
  const source = createHostDiscoverySnapshotSource({
    commandRunner: runner,
    cacheTtlMs: 0,
  });
  const external = createExternalCliSessionDiscovery({
    hostSnapshot: source.get,
    freshHostSnapshot: source.getFresh,
  });
  const live = createLiveGjcSessionDiscovery({ hostSnapshot: source.get });

  resetHostCommandCounters();
  const scans = Promise.all([
    external.getExternalCliSessionsDetailed(),
    live.getLiveGjcSessionsDetailed(),
  ]);
  release();
  await scans;

  const counters = snapshotHostCommandCounters();
  assert.equal(counters['tmux list-panes'], 1);
  assert.equal(counters['ps -eo'], 1);
});

test('shared host command cost remains one tmux/ps pair per collector cadence', async () => {
  let now = 0;
  const runner = async (command: string): Promise<string> => (
    command === 'tmux' ? TMUX_OUTPUT : PS_OUTPUT
  );
  const source = createHostDiscoverySnapshotSource({
    commandRunner: runner,
    now: () => now,
    cacheTtlMs: 0,
  });
  const external = createExternalCliSessionDiscovery({
    now: () => now,
    cacheTtlMs: 0,
    hostSnapshot: source.get,
    freshHostSnapshot: source.getFresh,
  });
  const live = createLiveGjcSessionDiscovery({ hostSnapshot: source.get });

  resetHostCommandCounters();
  for (let tick = 0; tick < 10; tick += 1) {
    now += 3_000;
    await Promise.all([
      external.getExternalCliSessionsDetailed(),
      live.getLiveGjcSessionsDetailed(),
    ]);
  }
  const counters = snapshotHostCommandCounters();
  assert.equal(counters['tmux list-panes'], 10);
  assert.equal(counters['ps -eo'], 10);
});
