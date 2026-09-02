import assert from 'node:assert/strict';
import test from 'node:test';
import { lstat, mkdir, mkdtemp, realpath, rm, stat, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { ensureHomeCwd } from '@/modules/providers/services/external-cli-sessions/inference-and-spawn.js';

const defaultIo = { realpath, lstat, mkdir, stat };

function fsError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

test('ensureHomeCwd aborts a parent symlink swap before creating through it', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'chatmux-cwd-swap-'));
  const home = path.join(root, 'home');
  const evil = path.join(root, 'evil');
  await Promise.all([mkdir(home), mkdir(evil)]);
  const first = path.join(home, 'first');
  const target = path.join(first, 'second');
  const mkdirCalls: string[] = [];

  const io = {
    ...defaultIo,
    mkdir: async (pathname: string) => {
      mkdirCalls.push(pathname);
      await mkdir(pathname);
      if (pathname === first) {
        await rm(first, { recursive: true });
        await symlink(evil, first);
      }
    },
  };

  try {
    assert.equal(await ensureHomeCwd(target, home, io), null);
    assert.deepEqual(mkdirCalls, [first], 'mkdir never traverses the swapped symlink parent');
    await assert.rejects(lstat(path.join(evil, 'second')), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('ensureHomeCwd aborts when ancestor discovery hits EACCES', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'chatmux-cwd-eacces-'));
  const home = path.join(root, 'home');
  const target = path.join(home, 'blocked', 'child');
  await mkdir(home);
  let mkdirCalled = false;
  const io = {
    ...defaultIo,
    realpath: async (pathname: string) => {
      if (pathname === target) throw fsError('EACCES');
      return realpath(pathname);
    },
    mkdir: async (pathname: string) => {
      mkdirCalled = true;
      await mkdir(pathname);
    },
  };

  try {
    assert.equal(await ensureHomeCwd(target, home, io), null);
    assert.equal(mkdirCalled, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('ensureHomeCwd aborts an EACCES error during the component walk', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'chatmux-cwd-walk-eacces-'));
  const home = path.join(root, 'home');
  await mkdir(home);
  const first = path.join(home, 'first');
  const blocked = path.join(first, 'blocked');
  const mkdirCalls: string[] = [];
  const io = {
    ...defaultIo,
    lstat: async (pathname: string) => {
      if (pathname === blocked) throw fsError('EACCES');
      return lstat(pathname);
    },
    mkdir: async (pathname: string) => {
      mkdirCalls.push(pathname);
      await mkdir(pathname);
    },
  };

  try {
    assert.equal(await ensureHomeCwd(blocked, home, io), null);
    assert.deepEqual(mkdirCalls, [first]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('ensureHomeCwd rejects an EEXIST race that installs a symlink', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'chatmux-cwd-eexist-'));
  const home = path.join(root, 'home');
  const evil = path.join(root, 'evil');
  await Promise.all([mkdir(home), mkdir(evil)]);
  const raced = path.join(home, 'raced');
  const target = path.join(raced, 'child');
  let racedOnce = false;
  const io = {
    ...defaultIo,
    mkdir: async (pathname: string) => {
      if (pathname === raced && !racedOnce) {
        racedOnce = true;
        await symlink(evil, raced);
        throw fsError('EEXIST');
      }
      await mkdir(pathname);
    },
  };

  try {
    assert.equal(await ensureHomeCwd(target, home, io), null);
    assert.equal((await lstat(raced)).isSymbolicLink(), true);
    await assert.rejects(lstat(path.join(evil, 'child')), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
