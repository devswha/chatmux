import { EventEmitter } from 'node:events';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { spawn as realSpawn } from 'cross-spawn';

import { installPluginFromGit, updatePluginFromGit } from './plugin-loader.js';
import { startPluginServer, stopPluginServer } from './plugin-process-manager.js';

function runGit(args, cwd) {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

function createFixture(root, name = 'local-plugin') {
  const repoDir = path.join(root, name);
  fs.mkdirSync(repoDir, { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'manifest.json'), JSON.stringify({
    name: 'smoke-plugin',
    displayName: 'Smoke Plugin',
    entry: 'index.js',
    version: '1.0.0',
  }));
  fs.writeFileSync(path.join(repoDir, 'index.js'), 'export default {};\n');
  fs.writeFileSync(path.join(repoDir, 'package.json'), JSON.stringify({
    scripts: { build: 'node -e "process.exit(0)"' },
  }));
  runGit(['init'], repoDir);
  runGit(['config', 'user.email', 'smoke@example.test'], repoDir);
  runGit(['config', 'user.name', 'Plugin Smoke Test'], repoDir);
  runGit(['add', '.'], repoDir);
  runGit(['commit', '-m', 'initial plugin'], repoDir);
  return repoDir;
}

function createNpmStub(calls) {
  return (command, args, options) => {
    calls.push({ command, args, options });
    if (command === 'git') return realSpawn(command, args, options);

    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => true;
    queueMicrotask(() => child.emit('close', 0));
    return child;
  };
}

test('plugin install clones a local fixture, ignores npm scripts, and runs its declared build', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chatmux-plugin-install-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repoDir = createFixture(root);
  const pluginsDir = path.join(root, 'plugins');
  fs.mkdirSync(pluginsDir);
  const calls = [];

  const manifest = await installPluginFromGit(repoDir, { pluginsDir, spawnFn: createNpmStub(calls) });

  assert.equal(manifest.name, 'smoke-plugin');
  assert.ok(fs.existsSync(path.join(pluginsDir, 'local-plugin', 'manifest.json')));
  assert.deepEqual(calls.map(({ command, args }) => [command, args]), [
    ['git', ['clone', '--depth', '1', '--', repoDir, calls[0].args[5]]],
    ['npm', ['install', '--ignore-scripts']],
    ['npm', ['run', 'build']],
  ]);
  assert.match(calls[0].args[5], /^.*\.tmp-local-plugin-/);
});
test('plugin install checks duplicate names only in the injected plugins directory', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chatmux-plugin-duplicate-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repoDir = createFixture(root, 'candidate-plugin');
  const pluginsDir = path.join(root, 'plugins');
  const existingDir = path.join(pluginsDir, 'existing-plugin');
  fs.mkdirSync(existingDir, { recursive: true });
  fs.writeFileSync(path.join(existingDir, 'manifest.json'), JSON.stringify({
    name: 'smoke-plugin',
    displayName: 'Existing Plugin',
    entry: 'index.js',
  }));

  const hostConfigDir = path.join(os.homedir(), '.claude-code-ui');
  const originalFsMethods = {
    existsSync: fs.existsSync,
    readFileSync: fs.readFileSync,
    readdirSync: fs.readdirSync,
    mkdirSync: fs.mkdirSync,
  };
  const hostPathsTouched = [];
  for (const method of Object.keys(originalFsMethods)) {
    fs[method] = (...args) => {
      const candidate = args[0];
      if (typeof candidate === 'string'
        && (candidate === hostConfigDir || candidate.startsWith(`${hostConfigDir}${path.sep}`))) {
        hostPathsTouched.push(candidate);
      }
      return originalFsMethods[method](...args);
    };
  }
  try {
    await assert.rejects(
      installPluginFromGit(repoDir, { pluginsDir, spawnFn: createNpmStub([]) }),
      /A plugin named "smoke-plugin" is already installed \(in "existing-plugin"\)/,
    );
  } finally {
    for (const [method, original] of Object.entries(originalFsMethods)) {
      fs[method] = original;
    }
  }

  assert.deepEqual(hostPathsTouched, [], 'install must not read or create paths under the host configuration directory');
});

test('plugin update fast-forwards a local fixture and keeps npm lifecycle scripts disabled', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chatmux-plugin-update-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repoDir = createFixture(root);
  const pluginsDir = path.join(root, 'plugins');
  fs.mkdirSync(pluginsDir);
  const installCalls = [];
  await installPluginFromGit(repoDir, { pluginsDir, spawnFn: createNpmStub(installCalls) });

  fs.writeFileSync(path.join(repoDir, 'manifest.json'), JSON.stringify({
    name: 'smoke-plugin',
    displayName: 'Smoke Plugin',
    entry: 'index.js',
    version: '2.0.0',
  }));
  runGit(['add', 'manifest.json'], repoDir);
  runGit(['commit', '-m', 'update plugin'], repoDir);

  const calls = [];
  const pluginDir = path.join(pluginsDir, 'local-plugin');
  const manifest = await updatePluginFromGit('smoke-plugin', { pluginDir, spawnFn: createNpmStub(calls) });

  assert.equal(manifest.version, '2.0.0');
  assert.deepEqual(calls.map(({ command, args }) => [command, args]), [
    ['git', ['pull', '--ff-only', '--']],
    ['npm', ['install', '--ignore-scripts']],
    ['npm', ['run', 'build']],
  ]);
});

test('plugin server starts and stops with explicit host HOME and PATH', async (t) => {
  const pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatmux-plugin-server-'));
  const environmentPath = path.join(pluginDir, 'environment.json');
  const serverPath = path.join(pluginDir, 'server.mjs');
  const pluginName = `smoke-server-${process.pid}-${Date.now()}`;
  t.after(async () => {
    await stopPluginServer(pluginName);
    fs.rmSync(pluginDir, { recursive: true, force: true });
  });
  fs.writeFileSync(serverPath, `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(environmentPath)}, JSON.stringify({ HOME: process.env.HOME, PATH: process.env.PATH }));\nconsole.log(JSON.stringify({ ready: true, port: 43123 }));\nsetInterval(() => {}, 1000);\n`);

  const port = await startPluginServer(pluginName, pluginDir, 'server.mjs');

  assert.equal(port, 43123);
  assert.deepEqual(JSON.parse(fs.readFileSync(environmentPath, 'utf8')), {
    HOME: process.env.HOME,
    PATH: process.env.PATH,
  });
  await stopPluginServer(pluginName);
});
