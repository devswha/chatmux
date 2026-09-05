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

const EXPLICIT_ENV = { CHATMUX_TMUX_SOCKETS: '[{"path":"/tmp/one.sock"},{"path":"/tmp/two.sock"}]' };
const socketInspector = async (socketPath: string) => ({ socketPath, generation: 'generation-one' });
const socketOutput = (socket: string): string => `${socket}\t$0\t@0\t%0\tsame\t100\tssh\t\t/work\t\t`;

test('explicit sockets preserve duplicate pane coordinates and share one ps per concurrent host capture', async () => {
  const commands: string[][] = [];
  const source = createHostDiscoverySnapshotSource({
    env: EXPLICIT_ENV, socketInspector,
    commandRunner: async (command, args) => {
      commands.push([command, ...args]);
      return command === 'ps' ? PS_OUTPUT : socketOutput(args[1]);
    },
  });
  resetHostCommandCounters();
  const snapshots = await Promise.all(Array.from({ length: 50 }, () => source.get()));
  const snapshot = snapshots[0];
  assert.ok(snapshots.every((value) => value === snapshot));
  assert.equal(snapshot.ok, true);
  assert.deepEqual(snapshot.panes.map((pane) => [pane.tmux.socketPath, pane.tmux.paneId]), [
    ['/tmp/one.sock', '%0'], ['/tmp/two.sock', '%0'],
  ]);
  assert.equal(commands.filter(([command]) => command === 'ps').length, 1);
  assert.equal(commands.filter(([command]) => command === 'tmux').length, 2);
  assert.deepEqual(snapshotHostCommandCounters(), { 'ps -eo': 1, 'tmux list-panes': 2 });
  source.dispose();
});

test('partial socket failure preserves unrelated fresh evidence but refuses aggregate freshness', async () => {
  const result = await captureHostDiscoveryPanes(async (_command, args) => {
    if (args[1] === '/tmp/two.sock') throw new Error('private /tmp/two.sock diagnostics');
    return socketOutput(args[1]);
  }, Date.now, { env: EXPLICIT_ENV, socketInspector });
  assert.equal(result.ok, false);
  assert.deepEqual(result.panes.map((pane) => pane.tmux.socketPath), ['/tmp/one.sock']);
  assert.deepEqual(result.sockets?.map(({ ok, panes, reason }) => ({ ok, count: panes.length, reason })), [
    { ok: true, count: 1, reason: undefined }, { ok: false, count: 0, reason: 'capture_failed' },
  ]);
  assert.equal(JSON.stringify(result.sockets?.filter((socket) => !socket.ok)).includes('/tmp'), false);
  const external = createExternalCliSessionDiscovery({ freshHostSnapshot: async () => ({ ...result, processes: [] }) });
  assert.deepEqual(await external.getExternalCliSessionsFresh(), [], 'failed aggregates cannot authorize retained targets');
  const live = createLiveGjcSessionDiscovery({ hostSnapshot: async () => ({ ...result, processes: [] }) });
  assert.equal((await live.getLiveGjcSessionsDetailed()).ok, false);
});

test('wrong reported socket, replaced socket, malformed output and owner inspection failure are unavailable', async () => {
  for (const mode of ['reported', 'replaced', 'malformed', 'owner'] as const) {
    let inspections = 0;
    let commands = 0;
    const result = await captureHostDiscoveryPanes(async () => {
      commands += 1;
      return mode === 'malformed' ? 'broken row' : socketOutput(mode === 'reported' ? '/tmp/unlisted.sock' : '/tmp/one.sock');
    }, Date.now, {
      env: { CHATMUX_TMUX_SOCKETS: '[{"path":"/tmp/one.sock"}]' },
      socketInspector: async (socketPath) => {
        if (mode === 'owner') throw new Error('foreign owner secret');
        inspections += 1;
        return { socketPath, generation: mode === 'replaced' ? String(inspections) : 'stable' };
      },
    });
    assert.equal(result.ok, false, mode);
    assert.equal(result.panes.length, 0, mode);
    if (mode === 'owner') assert.equal(commands, 0);
  }
});

test('invalid inventory and resolved name/path duplicates reject before any process launches', async () => {
  const root = await import('node:fs/promises').then(({ realpath }) => realpath('/tmp'));
  for (const config of ['[]', 'bad', JSON.stringify([{ name: 'default' }, { path: `${root}/tmux-${process.getuid!()}/default` }])]) {
    let launches = 0;
    const source = createHostDiscoverySnapshotSource({
      env: { CHATMUX_TMUX_SOCKETS: config }, socketInspector,
      commandRunner: async () => { launches += 1; return ''; },
    });
    const result = await source.get();
    assert.equal(result.ok, false);
    assert.equal(result.failure, 'configuration_invalid');
    assert.equal(launches, 0);
    source.dispose();
  }
});

test('inventory change invalidates completed cache and results from an in-flight capture', async () => {
  const env = { ...EXPLICIT_ENV };
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const source = createHostDiscoverySnapshotSource({
    env, socketInspector, cacheTtlMs: 60_000,
    commandRunner: async (command, args) => { await gate; return command === 'tmux' ? socketOutput(args[1]) : PS_OUTPUT; },
  });
  const pending = source.get();
  env.CHATMUX_TMUX_SOCKETS = '[]';
  release();
  assert.equal((await pending).ok, false);
  assert.equal((await source.get()).failure, 'configuration_invalid');
  source.dispose();
});

test('successful empty socket capture is distinct from unavailable in both lanes', async () => {
  const source = createHostDiscoverySnapshotSource({
    env: EXPLICIT_ENV, socketInspector, commandRunner: async () => '',
  });
  const snapshot = await source.get();
  assert.equal(snapshot.ok, true);
  assert.deepEqual(snapshot.panes, []);
  const live = createLiveGjcSessionDiscovery({ hostSnapshot: async () => snapshot });
  assert.equal((await live.getLiveGjcSessionsDetailed()).ok, true);
  source.dispose();
});

test('disposal aborts capture children and prevents cached evidence from being reused', async () => {
  let launched!: () => void;
  const started = new Promise<void>((resolve) => { launched = resolve; });
  let observedSignal: AbortSignal | undefined;
  const source = createHostDiscoverySnapshotSource({
    env: {},
    commandRunner: async (_command, _args, _timeout, signal) => {
      observedSignal = signal;
      launched();
      return new Promise<string>((_resolve, reject) => signal!.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
    },
  });
  const pending = source.get();
  await started;
  source.dispose();
  assert.equal((await pending).ok, false);
  assert.equal(observedSignal?.aborted, true);
  assert.equal((await source.get()).failure, 'cancelled');
});

test('configuration churn drains one capture before launching another inventory generation', async () => {
  const env = { ...EXPLICIT_ENV };
  let launched!: () => void;
  const started = new Promise<void>((resolve) => { launched = resolve; });
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let commands = 0;
  const source = createHostDiscoverySnapshotSource({ env, socketInspector, commandRunner: async (command, args) => {
    commands += 1; launched(); await blocked; return command === 'ps' ? PS_OUTPUT : socketOutput(args[1]);
  } });
  const first = source.get();
  await started;
  const requests = [first];
  for (let i = 0; i < 20; i += 1) {
    env.CHATMUX_TMUX_SOCKETS = JSON.stringify([{ path: `/tmp/churn-${i}.sock` }]);
    requests.push(source.get());
  }
  release();
  const snapshots = await Promise.all(requests);
  assert.ok(snapshots.every((snapshot) => !snapshot.ok));
  assert.ok(commands <= 3, 'inventory churn cannot exceed the first capture K+1 commands');
  source.dispose();
});

test('disposal settles a capture blocked on filesystem inspection', async () => {
  let inspected!: () => void;
  const started = new Promise<void>((resolve) => { inspected = resolve; });
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const source = createHostDiscoverySnapshotSource({ env: EXPLICIT_ENV, commandRunner: async () => '', socketInspector: async (socketPath) => {
    inspected(); await blocked; return { socketPath, generation: 'same' };
  } });
  const pending = source.get();
  await started;
  source.dispose();
  try { assert.equal((await pending).failure, 'cancelled'); } finally { release(); }
});

test('socket identity preserves whitespace in explicit absolute paths', async () => {
  const path = '/tmp/socket with space ';
  const result = await captureHostDiscoveryPanes(async () => socketOutput(path), Date.now, {
    env: { CHATMUX_TMUX_SOCKETS: JSON.stringify([{ path }]) }, socketInspector,
  });
  assert.equal(result.ok, true);
  assert.equal(result.panes[0].tmux.socketPath, path);
});
