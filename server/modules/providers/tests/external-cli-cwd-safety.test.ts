import assert from 'node:assert/strict';
import test from 'node:test';
import { lstat, mkdir, mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { ensureHomeCwd } from '@/modules/providers/services/external-cli-sessions/inference-and-spawn.js';

function fsError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

async function fixture(prefix: string): Promise<{
  root: string;
  home: string;
  target: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  const home = path.join(root, 'home');
  const target = path.join(home, 'first', 'second');
  await mkdir(home);
  return { root, home, target };
}

function testIo(
  createUnderRoot: (root: string, components: string[]) => Promise<
    { ok: true; path: string } | { ok: false; code: string }
  >,
) {
  const mkdirCalls: string[] = [];
  return {
    realpath: (pathname: string) => realpath(pathname),
    lstat: (pathname: string) => lstat(pathname),
    stat: (pathname: string) => stat(pathname),
    mkdir: async (pathname: string) => {
      mkdirCalls.push(pathname);
    },
    createUnderRoot,
    mkdirCalls,
  };
}

const unixTest = process.platform === 'win32' ? test.skip : test;

unixTest('ensureHomeCwd delegates the proven ancestor and suffix to the native core', async () => {
  const { root, home, target } = await fixture('chatmux-cwd-delegate-');
  const anchoredPath = path.join(home, 'native-result');
  const calls: Array<{ root: string; components: string[] }> = [];

  const io = testIo(async (provenRoot, components) => {
    calls.push({ root: provenRoot, components });
    return { ok: true, path: anchoredPath };
  });
  try {
    const result = await ensureHomeCwd(target, home, io);

    assert.equal(result, anchoredPath, 'only the core-returned anchored path is accepted');
    assert.deepEqual(calls, [{ root: await realpath(home), components: ['first', 'second'] }]);
    assert.deepEqual(io.mkdirCalls, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const [name, create] of [
  ['failure', async () => ({ ok: false as const, code: 'CORE_ERROR' })],
  ['timeout', async () => ({ ok: false as const, code: 'TIMEOUT' })],
  ['exception', async () => { throw new Error('native core failed'); }],
  [
    'malformed output',
    async () => ({ ok: true, path: 42 }) as unknown as { ok: true; path: string },
  ],
] as const) {
  unixTest(`ensureHomeCwd fails closed on native core ${name}`, async () => {
    const { root, home, target } = await fixture(`chatmux-cwd-${name.replace(' ', '-')}-`);
    const io = testIo(create);
    try {
      assert.equal(await ensureHomeCwd(target, home, io), null);
      assert.deepEqual(io.mkdirCalls, []);
      await assert.rejects(lstat(path.join(home, 'first')), { code: 'ENOENT' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

unixTest('ensureHomeCwd aborts when ancestor discovery hits EACCES', async () => {
  const { root, home, target } = await fixture('chatmux-cwd-eacces-');
  let createCalled = false;
  const io = testIo(async () => {
    createCalled = true;
    return { ok: true, path: target };
  });
  io.realpath = async (pathname: string) => {
    if (pathname === target) throw fsError('EACCES');
    return realpath(pathname);
  };

  try {
    assert.equal(await ensureHomeCwd(target, home, io), null);
    assert.equal(createCalled, false);
    assert.deepEqual(io.mkdirCalls, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
