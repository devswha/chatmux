import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, lstat, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { ensureHomeCwd } from '@/modules/providers/services/external-cli-sessions/inference-and-spawn.js';

const executable = process.platform === 'win32' ? 'chatmux-core.exe' : 'chatmux-core';
const corePath = fileURLToPath(new URL('../../../../dist-native/' + executable, import.meta.url));

type CoreOutput =
  | { ok: true; path: string }
  | { ok: false; code: string; component?: string };

function runMkdirUnder(home: string, components: string[]): Promise<{
  code: number | null;
  output: CoreOutput;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(corePath, ['mkdir-under', '--home', home, '--', ...components], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('chatmux-core mkdir-under test timed out'));
    }, 5_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      try {
        resolve({ code, output: JSON.parse(stdout) as CoreOutput });
      } catch (error) {
        reject(new Error(`invalid core output; stderr=${stderr}`, { cause: error }));
      }
    });
  });
}

test('real native core creates nested directories and refuses a symlink component', async (t) => {
  if (process.platform === 'win32') {
    t.skip('mkdir-under is explicitly unsupported by the native core on Windows');
    return;
  }
  try {
    await access(corePath);
  } catch {
    t.skip(`native core binary is absent at ${corePath}; run npm run build:core:dev`);
    return;
  }

  const temporary = await mkdtemp(path.join(os.tmpdir(), 'chatmux-cwd-core-'));
  const home = path.join(temporary, 'home');
  const outside = path.join(temporary, 'outside');
  await Promise.all([mkdir(home), mkdir(outside)]);

  try {
    const nested = path.join(home, 'workspace', 'nested');
    assert.equal(await ensureHomeCwd(nested, home), nested);
    assert.equal((await lstat(nested)).isDirectory(), true);

    const target = path.join(home, 'target');
    await mkdir(path.join(target, 'existing'), { recursive: true });
    await symlink(target, path.join(home, 'leading-link'));
    assert.equal(
      await ensureHomeCwd(path.join(home, 'leading-link', 'existing', 'must-not-exist'), home),
      null,
    );
    assert.equal((await lstat(path.join(home, 'leading-link'))).isSymbolicLink(), true);
    assert.equal((await lstat(path.join(target, 'existing'))).isDirectory(), true);
    await assert.rejects(lstat(path.join(target, 'existing', 'must-not-exist')), { code: 'ENOENT' });

    await symlink(outside, path.join(home, 'link'));
    const rejected = await runMkdirUnder(home, ['link', 'escaped']);
    assert.notEqual(rejected.code, 0);
    assert.equal(rejected.output.ok, false);
    assert.equal((await lstat(path.join(home, 'link'))).isSymbolicLink(), true);
    await assert.rejects(lstat(path.join(outside, 'escaped')), { code: 'ENOENT' });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
