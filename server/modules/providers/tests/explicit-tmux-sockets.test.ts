import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { lstat, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import test from 'node:test';

import { tmuxPaneIdentityKey } from '../../../../shared/tmux.js';
import { captureHostDiscoveryPanes, captureHostDiscoverySnapshot, runHostDiscoveryCommand } from '../services/host-discovery-snapshot.service.js';
import { createAttachCapabilityService } from '../services/attach-capability.service.js';
import { assertFreshExternalTmuxTarget } from '../services/tmux-fresh-verifier.service.js';
import { assertTmuxPaneIdentity, captureTmuxPane, sendTmuxProcessAction, stopAgentProcessInPane } from '../services/tmux-pane-actions.service.js';
import { inspectLocalTmuxSocket, rememberLocalTmuxSocket } from '../services/local-tmux-discovery.service.js';
import { createDiscoveryCollector, UNAVAILABLE_DEGRADE_TICKS } from '../services/discovery-collector.service.js';
import { createExternalCliSessionDiscovery } from '../services/external-cli-sessions.service.js';
import { createLiveGjcSessionDiscovery } from '../services/live-sessions.service.js';

const execFileAsync = promisify(execFile);
const coordinates = { sessionId: '$0', windowId: '@0', paneId: '%0' };

async function listen(path: string): Promise<Server> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(path, resolve); });
  return server;
}
async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

// These foreground servers use only test-owned paths and /dev/null config.
// Killing their ChildProcess never addresses the user's tmux server or sessions.
async function isolatedTmux(socket: string, env: NodeJS.ProcessEnv) {
  await mkdir(join(socket, '..'), { recursive: true, mode: 0o700 });
  const child = spawn('tmux', ['-D', '-S', socket, '-f', '/dev/null'], { env, stdio: 'ignore' });
  const exit = new Promise<void>((resolve) => child.once('close', () => resolve()));
  const dispose = async (): Promise<void> => { child.kill('SIGTERM'); await exit; };
  try {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (child.exitCode !== null) throw new Error('isolated tmux exited before readiness');
      if (await lstat(socket).then((stat) => stat.isSocket()).catch(() => false)) {
        const run = async (args: string[]): Promise<string> => (await execFileAsync('tmux', ['-S', socket, ...args], { env, timeout: 4000 })).stdout;
        return { run, dispose };
      }
      await delay(10);
    }
    throw new Error('isolated tmux readiness timed out');
  } catch (error) { await dispose(); throw error; }
}

test('real isolated -L and -S servers retain duplicate pane IDs and partial failure evidence', { timeout: 15_000 }, async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'chatmux-explicit-'));
  const namedPath = join(root, `tmux-${process.getuid!()}`, 'named');
  const absolutePath = join(root, 'absolute.sock');
  const env = { ...process.env, TMUX: '', TMUX_TMPDIR: root,
    CHATMUX_TMUX_SOCKETS: JSON.stringify([{ name: 'named' }, { path: absolutePath }]),
  };
  const owned: Awaited<ReturnType<typeof isolatedTmux>>[] = [];
  try {
    const first = await isolatedTmux(namedPath, env); owned.push(first);
    const second = await isolatedTmux(absolutePath, env); owned.push(second);
    await first.run(['new-session', '-d', '-s', 'same', 'sleep', '60']);
    await second.run(['new-session', '-d', '-s', 'same', 'sleep', '60']);
    const both = await captureHostDiscoverySnapshot(undefined, Date.now, { env });
    assert.equal(both.ok, true);
    assert.deepEqual(both.panes.map((pane) => pane.tmux.paneId), ['%0', '%0']);
    assert.equal(new Set(both.panes.map((pane) => tmuxPaneIdentityKey(pane.tmux))).size, 2);
    assert.deepEqual(both.panes.map((pane) => pane.tmux.socketPath), [namedPath, absolutePath]);
    await first.dispose(); owned.shift();
    const partial = await captureHostDiscoveryPanes(undefined, Date.now, { env });
    assert.equal(partial.ok, false);
    assert.deepEqual(partial.sockets?.map((socket) => socket.ok), [false, true]);
    assert.deepEqual(partial.panes.map((pane) => pane.tmux.socketPath), [absolutePath]);
    assert.equal((await second.run(['display-message', '-p', '-t', '%0', '#{session_name}'])).trim(), 'same');
  } finally {
    await Promise.all(owned.map((server) => server.dispose()));
    await rm(root, { recursive: true, force: true });
  }
});

test('replaced sockets and removed inventory reject mint, action, output and attach capabilities', async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'chatmux-action-sockets-'));
  const path = join(root, 'socket');
  const previous = process.env.CHATMUX_TMUX_SOCKETS;
  let server = await listen(path);
  try {
    process.env.CHATMUX_TMUX_SOCKETS = JSON.stringify([{ path }]);
    const identity = { socketPath: path, ...coordinates };
    rememberLocalTmuxSocket(identity, await inspectLocalTmuxSocket(path));
    const generation = { pid: 100, startedAtMs: 12345 };
    const session = { tmuxName: 'same', tmux: identity, kind: 'codex' as const, agentPid: generation.pid, startedAtMs: generation.startedAtMs };
    const commands: string[][] = [];
    const run = async (args: string[]) => { commands.push(args); return { code: 0, output: '$0\t@0\t%0' }; };
    const target = await assertFreshExternalTmuxTarget(identity, generation, { scan: async () => [session], assertPaneIdentity: (tmux) => assertTmuxPaneIdentity(tmux, run) });
    const capabilities = createAttachCapabilityService({ readPaneGeneration: async () => '100' });
    const token = await capabilities.issue('owner', identity);
    assert.ok(token);
    assert.equal(await capabilities.verify(token, 'owner', { ...identity }), true);
    commands.length = 0;
    process.env.CHATMUX_TMUX_SOCKETS = JSON.stringify([{ path: join(root, 'different') }]);
    await assert.rejects(sendTmuxProcessAction(target, 'escape', run), { code: 'TMUX_PANE_GENERATION_MISMATCH' });
    assert.equal(await capabilities.verify(token, 'owner', identity), false);
    assert.equal(commands.length, 0);
    process.env.CHATMUX_TMUX_SOCKETS = JSON.stringify([{ path }]);
    await close(server); server = await listen(path);
    await assert.rejects(assertFreshExternalTmuxTarget(identity, generation, { scan: async () => [session], assertPaneIdentity: (tmux) => assertTmuxPaneIdentity(tmux, run) }));
    await assert.rejects(sendTmuxProcessAction(target, 'escape', run));
    await assert.rejects(captureTmuxPane(target, run));
    await assert.rejects(stopAgentProcessInPane(target, run, '/bin/sh', { kill: () => assert.fail('no signals allowed') }));
    assert.equal(await capabilities.issue('owner', identity), null);
    assert.equal(await capabilities.verify(token, 'owner', { ...identity }), false);
    assert.equal(commands.length, 0, 'rejected evidence never launches a tmux action');
  } finally {
    if (previous === undefined) delete process.env.CHATMUX_TMUX_SOCKETS;
    else process.env.CHATMUX_TMUX_SOCKETS = previous;
    await close(server);
    await rm(root, { recursive: true, force: true });
  }
});

test('failed explicit socket keeps both display rows while fresh actions fail closed', async () => {
  let failed = false;
  const env = { CHATMUX_TMUX_SOCKETS: '[{"path":"/tmp/first.sock"},{"path":"/tmp/second.sock"}]' };
  const capture = () => captureHostDiscoverySnapshot(async (command, args) => {
    if (command === 'ps') return '100 1 ssh ssh';
    if (failed && args[1] === '/tmp/first.sock') throw new Error('unavailable');
    return `${args[1]}\t$0\t@0\t%0\tsame\t100\tssh\t\t/work\t\t`;
  }, Date.now, { env, socketInspector: async (socketPath) => ({ socketPath, generation: 'same' }) });
  const external = createExternalCliSessionDiscovery({ freshHostSnapshot: capture });
  const collector = createDiscoveryCollector({ scanHost: null, scanExternal: external.getExternalCliSessionsDetailedFresh, scanLive: async () => ({ ok: true, sessions: [] }) });
  try {
    await collector.tick();
    assert.equal(collector.currentSnapshot().rows.length, 2);
    failed = true;
    for (let tick = 0; tick < UNAVAILABLE_DEGRADE_TICKS; tick += 1) await collector.tick();
    assert.equal(collector.currentSnapshot().rows.length, 2);
    assert.equal(collector.currentSnapshot().health.external.ok, false);
    assert.deepEqual(await external.getExternalCliSessionsFresh(), []);
  } finally { collector.dispose(); }
});

test('unbound GJC panes with equal names and coordinates on different sockets have distinct synthetic IDs', async () => {
  const discovery = createLiveGjcSessionDiscovery({ hostSnapshot: async () => ({
    ok: true, capturedAtMs: Date.now(),
    panes: ['/tmp/first.sock', '/tmp/second.sock'].map((socketPath) => ({ name: 'same', tmux: { socketPath, ...coordinates }, pid: 9999999, command: 'gjc', cwd: '/nonexistent-chatmux-test' })),
    processes: [{ pid: 9999999, ppid: 1, comm: 'gjc', args: '/usr/local/bin/gjc' }],
  }) });
  const result = await discovery.getLiveGjcSessionsDetailed();
  assert.equal(result.ok, true);
  assert.equal(result.sessions.length, 2);
  assert.equal(new Set(result.sessions.map((session) => session.id)).size, 2);
  for (const session of result.sessions) assert.match(session.id, /^idle-gjc:[a-f0-9]{64}$/);
});

test('host command cancellation, timeout and output overflow stop only owned observation children', async () => {
  const controller = new AbortController();
  const pending = runHostDiscoveryCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], 4000, controller.signal);
  controller.abort();
  await assert.rejects(pending, { code: 'cancelled' });
  await assert.rejects(runHostDiscoveryCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], 30), { code: 'capture_failed' });
  await assert.rejects(runHostDiscoveryCommand(process.execPath, ['-e', "process.stdout.write('x'.repeat(9 * 1024 * 1024))"]), { code: 'capture_failed' });
});
