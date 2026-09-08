import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createConnection, createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { realSshTunnelIo, type SshProcess } from '@/modules/fleet/services/ssh-tunnel-io.js';

const listenerProgram = `
  const net = require('node:net');
  const server = net.createServer(socket => socket.end());
  server.listen(0, '127.0.0.1', () => {
    const probe = net.createConnection(process.argv[1], () => {
      probe.write(JSON.stringify({ pid: process.pid, parent: process.ppid, port: server.address().port }) + '\\n');
    });
    process.on('SIGTERM', () => server.close(() => probe.end()));
  });
`;

function exitOf(child: SshProcess): Promise<readonly [number | null, NodeJS.Signals | null]> {
  return new Promise(resolve => child.once('exit', (code, signal) => resolve([code, signal])));
}

async function probeFixture(context: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'chatmux-ssh-owner-'));
  const path = join(directory, 'probe');
  const ready = Promise.withResolvers<Readonly<{ pid: number; parent: number; port: number; socket: Socket }>>();
  let connection: Socket | undefined;
  const server = createServer(socket => {
    connection = socket;
    let input = '';
    socket.on('error', ready.reject);
    socket.on('data', bytes => {
      input += String(bytes);
      if (!input.includes('\n')) return;
      try {
        const value: unknown = JSON.parse(input.slice(0, input.indexOf('\n')));
        assert.ok(typeof value === 'object' && value !== null && 'pid' in value && 'parent' in value && 'port' in value);
        assert.equal(typeof value.pid, 'number'); assert.equal(typeof value.parent, 'number'); assert.equal(typeof value.port, 'number');
        ready.resolve({ pid: value.pid as number, parent: value.parent as number, port: value.port as number, socket });
      } catch (error) { ready.reject(error); }
    });
  });
  context.after(async () => {
    connection?.destroy();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  const listening = once(server, 'listening', { signal: AbortSignal.timeout(5_000) });
  server.listen(path); await listening;
  return { path, ready: ready.promise };
}

async function assertUnavailable(port: number): Promise<void> {
  const socket = createConnection({ host: '127.0.0.1', port });
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => reject(new Error('owned listener survived termination')));
      socket.once('error', error => {
        assert.ok('code' in error);
        if (error.code === 'ECONNREFUSED') resolve(); else reject(error);
      });
    });
  } finally { socket.destroy(); }
}

for (const code of [0, 23]) {
  test(`owned SSH IO preserves premature exit ${code}, including late exit subscribers`, { timeout: 5_000 }, async () => {
    const child = realSshTunnelIo.spawn(process.execPath, ['-e', `process.exit(${code})`], {});
    assert.deepEqual(await exitOf(child), [code, null]);
    assert.deepEqual(await exitOf(child), [code, null]);
  });
}

test('owned SSH IO stops its real child and listener before reporting exit', { timeout: 10_000 }, async context => {
  const fixture = await probeFixture(context);
  const child = realSshTunnelIo.spawn(process.execPath, ['-e', listenerProgram, fixture.path], {});
  const exited = exitOf(child);
  context.after(() => child.stop('SIGKILL'));
  const ready = await fixture.ready;
  assert.equal(ready.parent, child.pid, 'the tracked group leader is the direct child owner');
  const closed = once(ready.socket, 'close', { signal: AbortSignal.timeout(5_000) });
  child.stop('SIGTERM');
  await closed;
  assert.deepEqual(await exited, [0, null]);
  await assertUnavailable(ready.port);
});

test('owned SSH IO reports its real child signal rather than keeping the supervisor alive', { timeout: 10_000 }, async context => {
  const fixture = await probeFixture(context);
  const child = realSshTunnelIo.spawn(process.execPath, ['-e', listenerProgram, fixture.path], {});
  const exited = exitOf(child);
  context.after(() => child.stop('SIGKILL'));
  const ready = await fixture.ready;
  assert.equal(ready.parent, child.pid);
  const closed = once(ready.socket, 'close', { signal: AbortSignal.timeout(5_000) });
  process.kill(ready.pid, 'SIGKILL');
  assert.deepEqual(await exited, [null, 'SIGKILL']);
  await closed;
  await assertUnavailable(ready.port);
});

test('abrupt hub death closes an unpersisted owned child without needing a restore record', { timeout: 10_000 }, async context => {
  const fixture = await probeFixture(context);
  const moduleUrl = new URL('../services/ssh-tunnel-io.ts', import.meta.url).href;
  const worker = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import { realSshTunnelIo } from ${JSON.stringify(moduleUrl)};
    const child = realSshTunnelIo.spawn(process.execPath, ${JSON.stringify(['-e', listenerProgram, fixture.path])}, {});
    process.send({ pid: child.pid });
  `], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  const workerExited = once(worker, 'exit', { signal: AbortSignal.timeout(5_000) });
  const message = once(worker, 'message', { signal: AbortSignal.timeout(5_000) });
  context.after(async () => {
    if (worker.exitCode === null && worker.signalCode === null) worker.kill('SIGKILL');
    await workerExited;
  });
  const [value] = await message;
  assert.ok(typeof value === 'object' && value !== null && 'pid' in value && typeof value.pid === 'number');
  const ownedPid = value.pid;
  context.after(() => {
    try { realSshTunnelIo.killGroup(ownedPid, 'SIGKILL'); }
    catch (error) { if (!(error instanceof Error) || !('code' in error) || error.code !== 'ESRCH') throw error; }
  });
  const ready = await fixture.ready;
  const closed = once(ready.socket, 'close', { signal: AbortSignal.timeout(1_000) });
  worker.kill('SIGKILL');
  await workerExited;
  await closed;
  await assertUnavailable(ready.port);
});
