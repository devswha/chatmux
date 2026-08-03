import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import test from 'node:test';

import { runChatmuxRuntime } from './chatmux-runtime.mjs';

test('release runtime invokes the exported CLI with its original arguments', async () => {
  const calls = [];

  await runChatmuxRuntime({
    platform: 'linux',
    arch: 'x64',
    nodeVersion: '22.23.1',
    cliArgs: ['start', '--port=39001'],
    configPath: null,
    importCli: async () => ({
      runChatmuxCli: async (args) => {
        calls.push(args);
      },
    }),
  });

  assert.deepEqual(calls, [['start', '--port=39001']]);
});

test('release runtime rejects an artifact CLI without an invokable entrypoint', async () => {
  await assert.rejects(
    runChatmuxRuntime({
      platform: 'linux',
      arch: 'x64',
      nodeVersion: '22.23.1',
      configPath: null,
      importCli: async () => ({}),
    }),
    /CLI entrypoint is unavailable/,
  );
});

test('release runtime enforces the pinned platform before loading the CLI', async () => {
  let imported = false;

  await assert.rejects(
    runChatmuxRuntime({
      platform: 'linux',
      arch: 'x64',
      nodeVersion: '24.18.0',
      configPath: null,
      importCli: async () => {
        imported = true;
        return { runChatmuxCli: async () => {} };
      },
    }),
    /requires Linux x64 with Node.js 22/,
  );
  assert.equal(imported, false);
});

test('release runtime executes as main when invoked through a symlinked install path', () => {
  const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
  const releaseRoot = path.dirname(scriptsDir);
  const managedRoot = mkdtempSync(path.join(tmpdir(), 'chatmux-runtime-'));
  try {
    symlinkSync(releaseRoot, path.join(managedRoot, 'current'));
    const wrapper = path.join(managedRoot, 'current', 'scripts', 'chatmux-runtime.mjs');
    for (const preserveMain of [false, true]) {
      const nodeOptions = [
        process.env.NODE_OPTIONS,
        preserveMain ? '--preserve-symlinks-main' : '',
      ].filter(Boolean).join(' ');
      const result = spawnSync(process.execPath, [wrapper, 'chatmux-runtime-guard-probe'], {
        env: { ...process.env, CHATMUX_ENV_FILE: '', NODE_OPTIONS: nodeOptions },
        encoding: 'utf8',
        timeout: 10_000,
      });
      // The guard must fire through either Node symlink mode: the runtime reaches
      // the CLI or fails loudly on an unsupported platform, never exits silently.
      assert.notEqual(result.stdout + result.stderr, '');
    }
  } finally {
    rmSync(managedRoot, { recursive: true, force: true });
  }
});
