import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  assertLocalTmuxSocket,
  copyLocalTmuxSocketEvidence,
  inspectLocalTmuxSocket,
  LocalTmuxDiscoveryError,
  parseLocalTmuxSocketInventory,
  rememberLocalTmuxSocket,
  resolveLocalTmuxSocket,
} from '../services/local-tmux-discovery.service.js';

async function listen(path: string): Promise<Server> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(path, resolve); });
  return server;
}
async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

const tmux = { socketPath: '/tmp/test.sock', sessionId: '$0', windowId: '@0', paneId: '%0' };

test('explicit inventory is bounded, strict, and does not silently restore default selection', () => {
  assert.equal(parseLocalTmuxSocketInventory(undefined), null);
  assert.equal(parseLocalTmuxSocketInventory(''), null);
  assert.deepEqual(parseLocalTmuxSocketInventory('[{"name":"default"},{"path":"/tmp/work.sock"}]'), [
    { name: 'default' }, { path: '/tmp/work.sock' },
  ]);
  const invalid = [
    ' ', 'null', '{}', '[]', '["work"]', '[{"name":"a","path":"/tmp/a"}]',
    '[{"name":"a","extra":true}]', '[{"path":"relative"}]', '[{"path":"/tmp/../sock"}]',
    '[{"path":"/tmp//sock"}]', '[{"path":"/tmp/"}]', '[{"name":"../private"}]',
    '[{"name":"-S"}]', '[{"name":"$(id)"}]', '[{"name":"*"}]', '[{"name":""}]',
    '[{"path":"/tmp/secret\\nvalue"}]', '[{"path":"/tmp/secret\\u0000value"}]',
    '[{"name":"a"},{"name":"a"}]', '[{"path":"/tmp/a"},{"path":"/tmp/a"}]',
    JSON.stringify([{ name: 'a'.repeat(65) }]),
    JSON.stringify([{ path: `/${'é'.repeat(2048)}` }]),
    JSON.stringify(Array.from({ length: 9 }, (_, i) => ({ name: `n${i}` }))),
    ' '.repeat(32769),
  ];
  for (const value of invalid) {
    assert.throws(() => parseLocalTmuxSocketInventory(value), (error) => (
      error instanceof LocalTmuxDiscoveryError && error.code === 'configuration_invalid'
      && !error.message.includes('secret') && !error.message.includes('/tmp')
    ));
  }
});

test('names resolve using the service UID and explicit temp root, never inherited TMUX', async () => {
  const root = await realpath(tmpdir());
  const socket = await resolveLocalTmuxSocket({ name: 'work' }, { TMUX_TMPDIR: root, TMUX: '/unlisted/server,1,0' });
  assert.deepEqual(socket, { args: ['-L', 'work'], socketPath: join(root, `tmux-${process.getuid!()}`, 'work') });
  assert.deepEqual(await resolveLocalTmuxSocket({ path: '/tmp/exact.sock' }), {
    args: ['-S', '/tmp/exact.sock'], socketPath: '/tmp/exact.sock',
  });
  await assert.rejects(resolveLocalTmuxSocket({ name: 'work' }, { TMUX_TMPDIR: 'relative' }));
});

test('socket inspection rejects missing paths, files, symlinks and replaced generations', async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'chatmux-socket-inspect-'));
  const path = join(root, 'socket');
  let server: Server | undefined;
  try {
    await assert.rejects(inspectLocalTmuxSocket(path), { code: 'socket_unavailable' });
    await writeFile(path, 'not a socket');
    await assert.rejects(inspectLocalTmuxSocket(path), { code: 'socket_unavailable' });
    await rm(path);
    server = await listen(path);
    const before = await inspectLocalTmuxSocket(path);
    await assert.rejects(inspectLocalTmuxSocket(path, process.getuid!() + 1), { code: 'socket_unavailable' });
    await symlink(path, join(root, 'alias'));
    await assert.rejects(inspectLocalTmuxSocket(join(root, 'alias')), { code: 'socket_unavailable' });
    const identity = { ...tmux, socketPath: path };
    rememberLocalTmuxSocket(identity, before);
    const copy = Object.freeze({ ...identity });
    copyLocalTmuxSocketEvidence(identity, copy);
    const env = { CHATMUX_TMUX_SOCKETS: JSON.stringify([{ path }]) };
    assert.deepEqual(await assertLocalTmuxSocket(copy, env), before);
    assert.deepEqual(JSON.parse(JSON.stringify(copy)), identity, 'filesystem evidence is never serialized');
    await close(server);
    server = await listen(path);
    await assert.rejects(assertLocalTmuxSocket(copy, env), { code: 'socket_identity_changed' });
    await assert.rejects(assertLocalTmuxSocket(copy, {}), { code: 'socket_identity_changed' });
  } finally {
    if (server) await close(server);
    await rm(root, { recursive: true, force: true });
  }
});

test('exact inventory membership cannot be replaced by another socket or matching pane IDs', async () => {
  let inspections = 0;
  const inspect = async (socketPath: string) => { inspections += 1; return { socketPath, generation: 'same' }; };
  await assert.rejects(assertLocalTmuxSocket(tmux, { CHATMUX_TMUX_SOCKETS: '[{"path":"/tmp/other.sock"}]' }, inspect));
  assert.equal(inspections, 0, 'unlisted client paths never reach filesystem inspection');
  assert.equal(await assertLocalTmuxSocket(tmux, {}, inspect), null, 'unconfigured default behavior stays unchanged');
  assert.equal(inspections, 0);
  await assert.rejects(assertLocalTmuxSocket(tmux, { CHATMUX_TMUX_SOCKETS: 'invalid' }, inspect));
});

test('action inspection rejects inventory or root changes during asynchronous work', async () => {
  for (const change of ['remove', 'invalid', 'root'] as const) {
    const env = { CHATMUX_TMUX_SOCKETS: '[{"path":"/tmp/test.sock"}]', TMUX_TMPDIR: '/tmp' };
    await assert.rejects(assertLocalTmuxSocket(tmux, env, async (socketPath) => {
      if (change === 'remove') env.CHATMUX_TMUX_SOCKETS = '';
      if (change === 'invalid') env.CHATMUX_TMUX_SOCKETS = 'invalid';
      if (change === 'root') env.TMUX_TMPDIR = '/different';
      return { socketPath, generation: 'same' };
    }), { code: 'configuration_invalid' });
  }
});

test('action inspection rejects duplicate resolved inventory just like capture', async () => {
  const root = await realpath('/tmp');
  const socketPath = join(root, `tmux-${process.getuid!()}`, 'default');
  const env = { CHATMUX_TMUX_SOCKETS: JSON.stringify([{ name: 'default' }, { path: socketPath }]) };
  await assert.rejects(assertLocalTmuxSocket({ ...tmux, socketPath }, env, async () => assert.fail('invalid inventory cannot inspect a target')), { code: 'configuration_invalid' });
});

test('logical timeout and cancellation retain a bound on unfinished filesystem operations', async () => {
  const { boundedLocalTmuxInspection } = await import('../services/local-tmux-discovery.service.js');
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let started = 0;
  try {
    await Promise.all(Array.from({ length: 16 }, () => assert.rejects(boundedLocalTmuxInspection(async () => {
      started += 1; await blocked;
    }, undefined, 5), { code: 'socket_unavailable' })));
    await assert.rejects(boundedLocalTmuxInspection(async () => { started += 1; }), { code: 'socket_unavailable' });
    assert.equal(started, 16, 'timed-out work still occupies slots until its syscalls finish');
  } finally { release(); await blocked; }
});
