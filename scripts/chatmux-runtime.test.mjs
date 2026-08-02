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
