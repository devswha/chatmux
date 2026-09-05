import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, realpath, rename, rm, symlink } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { assertTmuxPaneIdentity, createAttachCapabilityService, readTmuxPaneIdentity } from '@/modules/providers/index.js';
// eslint-disable-next-line boundaries/dependencies -- exercise real ownership inspection without changing filesystem ownership.
import { inspectLocalTmuxSocket } from '@/modules/providers/services/local-tmux-discovery.service.js';

import { handleShellConnection, SHELL_PROTOCOL_VERSION, type ShellWebSocketDependencies } from '../services/shell-websocket.service.js';

class FakeWebSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  readonly sent: string[] = [];
  send(message: string): void { this.sent.push(message); }
  close(): void { this.readyState = 3; }
}

async function settled(ws: FakeWebSocket): Promise<void> {
  // Wait for an observable completion, not an assumed filesystem duration.
  for (let i = 0; i < 100 && !ws.sent.length; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(ws.sent.length, 'initialization completed');
}

async function fixture(t: TestContext, options: Pick<NonNullable<Parameters<typeof createAttachCapabilityService>[0]>, 'socketInspector'> = {}) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'chatmux-lease-'));
  const socketPath = join(root, 'socket');
  const previous = process.env.CHATMUX_TMUX_SOCKETS;
  const servers: Server[] = [];
  let exited: ((event: { exitCode: number }) => void) | undefined;
  t.after(async () => {
    try { exited?.({ exitCode: 0 }); } finally {
      if (previous === undefined) delete process.env.CHATMUX_TMUX_SOCKETS;
      else process.env.CHATMUX_TMUX_SOCKETS = previous;
      for (const server of servers.reverse()) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await rm(root, { recursive: true, force: true });
    }
  });
  const listen = async (): Promise<void> => {
    const server = createServer();
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
    servers.push(server);
  };
  await listen();
  process.env.CHATMUX_TMUX_SOCKETS = JSON.stringify([{ path: socketPath }]);
  const tmux = { socketPath, sessionId: '$0', windowId: '@0', paneId: '%0' };
  let now = 1_000;
  let generation: string | null = '100';
  const capabilities = createAttachCapabilityService({ ...options, now: () => now, ttlMs: 100, readPaneGeneration: async () => generation });
  const token = await capabilities.issue('owner', tmux);
  assert.ok(token);
  let spawns = 0;
  let kills = 0;
  const writes: string[] = [];
  let output: ((chunk: string) => void) | undefined;
  const diagnostics: unknown[] = [];
  const deps: ShellWebSocketDependencies = {
    principal: 'owner', attachCapabilities: capabilities,
    readTmuxPaneIdentity,
    assertTmuxPaneIdentity: (target) => assertTmuxPaneIdentity(target, async () => ({ code: 0, output: '$0\t@0\t%0' })),
    readTmuxSessionName: async () => 'work',
    getCurrentTmuxPaneIdentityState: async () => ({ state: 'not-hosted' }),
    resolveProviderSessionId: () => null,
    stripAnsiSequences: (value) => value, normalizeDetectedUrl: () => null,
    extractUrlsFromText: () => [], shouldAutoOpenUrlFromOutput: () => false,
    diagnostic: (event) => { diagnostics.push(event); },
    spawn: (() => {
      spawns += 1;
      return {
        onData: (listener: (chunk: string) => void) => { output = listener; },
        onExit: (listener: (event: { exitCode: number }) => void) => { exited = listener; },
        write: (data: string) => { writes.push(data); }, resize: () => undefined,
        kill: () => { kills += 1; },
      };
    }) as never,
  };
  const init = {
    type: 'init', shellProtocolVersion: SHELL_PROTOCOL_VERSION, mode: 'typed-attach', targetClass: 'attach-only',
    projectPath: process.cwd(), sessionId: 'replacement-review', tmux, capability: token,
  };
  const start = (overrides: Partial<ShellWebSocketDependencies> = {}, message: Record<string, unknown> = {}): FakeWebSocket => {
    const ws = new FakeWebSocket();
    handleShellConnection(ws as never, { ...deps, ...overrides });
    ws.emit('message', Buffer.from(JSON.stringify({ ...init, ...message })));
    return ws;
  };
  const connect = async (overrides: Partial<ShellWebSocketDependencies> = {}, message: Record<string, unknown> = {}): Promise<FakeWebSocket> => {
    const ws = start(overrides, message);
    await settled(ws);
    return ws;
  };
  return {
    root, socketPath, tmux, token, capabilities, start, connect, deps, diagnostics, writes,
    expire: () => { now += 100; }, setGeneration: (value: string | null) => { generation = value; },
    output: (chunk: string) => output?.(chunk),
    replace: async () => { await rename(socketPath, join(root, 'original')); await listen(); },
    counts: () => ({ spawns, kills }),
  };
}

function replayed(ws: FakeWebSocket): boolean {
  return ws.sent.some((message) => JSON.parse(message).type === 'replay_start');
}

test('replaced socket rejects the original reconnect reproduction before replay or cached PTY adoption', async (t) => {
  const f = await fixture(t);
  const owner = await f.connect();
  f.output('buffered original pane');
  await f.replace();
  assert.equal(await f.capabilities.verify(f.token, 'owner', f.tmux), false);
  const reconnect = await f.connect();
  assert.equal(replayed(reconnect), false);
  assert.ok(reconnect.sent.some((message) => message.includes('Error:')));
  reconnect.emit('message', Buffer.from(JSON.stringify({ type: 'input', data: 'refused input' })));
  reconnect.emit('close');
  f.output('original connection still owns the PTY');
  assert.match(owner.sent.join(''), /original connection still owns the PTY/);
  assert.doesNotMatch(reconnect.sent.join(''), /buffered original pane|original connection still owns the PTY/);
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.counts(), { spawns: 1, kills: 0 });
  assert.ok(!JSON.stringify(f.diagnostics).includes(f.socketPath));
});

test('healthy explicit socket lease reconnects after the capability expires and is pruned', async (t) => {
  const f = await fixture(t);
  await f.connect();
  f.output('buffered healthy pane');
  f.expire();
  assert.equal(f.capabilities.size(), 0);
  assert.equal(await f.capabilities.verify(f.token, 'owner', f.tmux), false);
  const reconnect = await f.connect();
  assert.equal(replayed(reconnect), true);
  assert.match(reconnect.sent.join(''), /buffered healthy pane/);
  reconnect.emit('message', Buffer.from(JSON.stringify({ type: 'input', data: 'verified input' })));
  assert.deepEqual(f.writes, ['verified input']);
  assert.deepEqual(f.counts(), { spawns: 1, kills: 0 });
});

for (const change of ['removed', 'invalid', 'disabled', 'missing', 'symlink', 'pane-generation', 'unreadable-generation'] as const) {
  test(`lease reconnect refuses ${change} proof without replay or terminating the existing PTY`, async (t) => {
    const f = await fixture(t);
    await f.connect();
    if (change === 'removed') process.env.CHATMUX_TMUX_SOCKETS = JSON.stringify([{ path: join(f.root, 'unlisted') }]);
    if (change === 'invalid') process.env.CHATMUX_TMUX_SOCKETS = '[]';
    if (change === 'disabled') delete process.env.CHATMUX_TMUX_SOCKETS;
    if (change === 'missing' || change === 'symlink') await rename(f.socketPath, join(f.root, 'original'));
    if (change === 'symlink') await symlink(join(f.root, 'original'), f.socketPath);
    if (change === 'pane-generation') f.setGeneration('101');
    if (change === 'unreadable-generation') f.setGeneration(null);
    const reconnect = await f.connect();
    assert.equal(replayed(reconnect), false);
    assert.deepEqual(f.counts(), { spawns: 1, kills: 0 });
  });
}

test('lease reconnect rechecks socket ownership without exposing inspection evidence', async (t) => {
  let uid = process.getuid!();
  const f = await fixture(t, { socketInspector: (path) => inspectLocalTmuxSocket(path, uid) });
  await f.connect();
  const evidence = await inspectLocalTmuxSocket(f.socketPath);
  uid += 1; // Real lstat with a mismatching expected UID; no chown or credentials.
  const reconnect = await f.connect();
  assert.equal(replayed(reconnect), false);
  assert.deepEqual(f.counts(), { spawns: 1, kills: 0 });
  const publicOutput = JSON.stringify([reconnect.sent, f.diagnostics]);
  assert.ok(!publicOutput.includes(evidence.generation));
  assert.ok(!publicOutput.includes(f.socketPath));
});

test('lease handles require private issuer proof and remain bound to the principal and exact pane', async (t) => {
  const f = await fixture(t);
  const lease = await f.capabilities.createLease(f.token, 'owner', f.tmux);
  assert.ok(lease);
  assert.deepEqual(JSON.parse(JSON.stringify(lease)), { principal: 'owner', tmux: f.tmux });
  assert.equal(await f.capabilities.verifyLease(lease, 'owner', f.tmux), true);
  for (const absent of [undefined, null, {}, { ...lease }, JSON.parse(JSON.stringify(lease))]) {
    assert.equal(await f.capabilities.verifyLease(absent, 'owner', f.tmux), false);
  }
  assert.equal(await f.capabilities.verifyLease(lease, 'other', f.tmux), false);
  for (const target of [
    { ...f.tmux, socketPath: '/tmp/unlisted.sock' }, { ...f.tmux, sessionId: '$1' },
    { ...f.tmux, windowId: '@1' }, { ...f.tmux, paneId: '%1' },
  ]) assert.equal(await f.capabilities.verifyLease(lease, 'owner', target), false);
  await f.connect();
  const reconnect = await f.connect({ attachCapabilities: createAttachCapabilityService({ readPaneGeneration: async () => '100' }) });
  assert.equal(replayed(reconnect), false, 'a service without original private proof cannot adopt the PTY');
  assert.deepEqual(f.counts(), { spawns: 1, kills: 0 });
});

test('reconnect waits for lease verification and refuses a socket replaced during the wait', async (t) => {
  const f = await fixture(t);
  const owner = await f.connect();
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const reconnect = f.start({ attachCapabilities: {
    ...f.capabilities,
    verifyLease: async (...args) => { entered(); await gate; return f.capabilities.verifyLease(...args); },
  } });
  await started;
  try {
    assert.deepEqual(reconnect.sent, []);
    reconnect.emit('message', Buffer.from(JSON.stringify({ type: 'input', data: 'unverified input' })));
    f.output('still owned while checking');
    assert.match(owner.sent.join(''), /still owned while checking/);
    assert.deepEqual(reconnect.sent, []);
    assert.deepEqual(f.writes, []);
    await f.replace();
  } finally { release(); }
  await settled(reconnect);
  assert.equal(replayed(reconnect), false);
  assert.deepEqual(f.counts(), { spawns: 1, kills: 0 });
});

test('a reconnect cannot adopt a cached PTY replaced while its lease inspection awaits completion', async (t) => {
  const f = await fixture(t);
  await f.connect();
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const reconnect = f.start({ attachCapabilities: {
    ...f.capabilities,
    verifyLease: async (...args) => {
      const verified = await f.capabilities.verifyLease(...args);
      entered(); await gate; return verified;
    },
  } });
  await started;
  let replacement: FakeWebSocket;
  try { replacement = await f.connect({}, { forceRestart: true }); } finally { release(); }
  await settled(reconnect);
  assert.equal(replayed(reconnect), false);
  f.output('replacement remains owned');
  assert.match(replacement.sent.join(''), /replacement remains owned/);
  assert.doesNotMatch(reconnect.sent.join(''), /replacement remains owned/);
  assert.deepEqual(f.counts(), { spawns: 2, kills: 1 });
});
