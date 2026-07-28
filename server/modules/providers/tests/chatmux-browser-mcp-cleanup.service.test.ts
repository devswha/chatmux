import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { ChatmuxBrowserMcpCleanupService } from '@/modules/providers/services/chatmux-browser-mcp-cleanup.service.js';
import { findServerRoot, getModuleDir } from '@/utils/runtime-paths.js';

const runId = () => crypto.randomUUID();
function home() { return fs.mkdtempSync(path.join(os.tmpdir(), 'chatmux-browser-cleanup-')); }
function write(file: string, value: string, mode = 0o600) { fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); fs.writeFileSync(file, value, { mode }); }
function managed(
  script = '/opt/chatmux/server/browser-use-mcp.js',
  token = 'secret',
  port = '3001',
) { return JSON.stringify({ mcpServers: { 'chatmux-browser': { type: 'stdio', command: process.execPath, args: [script], env: { CHATMUX_BROWSER_USE_MCP_TOKEN: token, CHATMUX_BROWSER_USE_API_URL: `http://127.0.0.1:${port}/api/browser-use-mcp` } } } }, null, 2); }
function service(dir: string) { return new ChatmuxBrowserMcpCleanupService({ homeDir: dir, serverScriptPath: '/opt/chatmux/server/browser-use-mcp.js', port: '3001', token: () => 'secret', isLiveServer: () => false, randomUUID: runId }); }

async function startHealthServer(): Promise<{ child: ChildProcess; port: string }> {
  const child = spawn(process.execPath, ['-e', `
    const http = require('http');
    const server = http.createServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ product: 'chatmux', protocolVersion: 1 }));
    });
    server.listen(0, '127.0.0.1', () => console.log(server.address().port));
  `], { stdio: ['ignore', 'pipe', 'inherit'] });
  const port = await new Promise<string>((resolve, reject) => {
    child.once('error', reject);
    child.stdout!.once('data', (chunk) => resolve(String(chunk).trim()));
  });
  return { child, port };
}

test('does nothing on construction or import', () => {
  const dir = home(); new ChatmuxBrowserMcpCleanupService({ homeDir: dir });
  assert.equal(fs.existsSync(path.join(dir, '.chatmux')), false);
});
test('derives the default script path from its runtime layout instead of cwd', () => {
  const dir = home();
  const script = path.join(findServerRoot(getModuleDir(import.meta.url)), 'browser-use-mcp.js');
  write(path.join(dir, '.claude.json'), managed(script));
  const previousCwd = process.cwd();
  const unrelatedCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'chatmux-unrelated-cwd-'));
  try {
    process.chdir(unrelatedCwd);
    assert.equal(new ChatmuxBrowserMcpCleanupService({
      homeDir: dir, port: '3001', token: () => 'secret', isLiveServer: () => false, randomUUID: runId,
    }).apply().status, 'completed');
  } finally {
    process.chdir(previousCwd);
  }
});
test('preserves JSONC comments and creates restricted backup files', () => {
  const dir = home();
  const config = path.join(dir, '.claude.json');
  write(config, `{
  // preserve this comment
  "mcpServers": {
    "chatmux-browser": {
      "type": "stdio",
      "command": "${process.execPath}",
      "args": ["/opt/chatmux/server/browser-use-mcp.js"],
      "env": {
        "CHATMUX_BROWSER_USE_MCP_TOKEN": "secret",
        "CHATMUX_BROWSER_USE_API_URL": "http://127.0.0.1:3001/api/browser-use-mcp"
      }
    }
  }
}`);
  const result = service(dir).apply();
  const backup = path.join(path.dirname(result.receiptPath), 'backups/claude.preimage');
  assert.equal(result.status, 'completed');
  assert.match(fs.readFileSync(config, 'utf8'), /preserve this comment/);
  assert.equal(fs.statSync(backup).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(backup)).mode & 0o777, 0o700);
});

test('recognizes the generated chatmux command shape', () => {
  const dir = home();
  const config = path.join(dir, '.claude.json');
  write(config, JSON.stringify({
    mcpServers: {
      'chatmux-browser': {
        type: 'stdio',
        command: 'chatmux',
        args: ['browser-use-mcp'],
        env: {
          CHATMUX_BROWSER_USE_MCP_TOKEN: 'secret',
          CHATMUX_BROWSER_USE_API_URL: 'http://127.0.0.1:3001/api/browser-use-mcp',
        },
      },
    },
  }));
  assert.equal(service(dir).apply().status, 'completed');
});

test('keeps raw private receipt evidence separate from public output', () => {
  const dir = home(); const config = path.join(dir, '.claude.json'); write(config, managed());
  const result = service(dir).apply();
  const receipt = fs.readFileSync(result.receiptPath, 'utf8');
  const privateProvider = JSON.parse(receipt).providers.find(
    (provider: { provider: string }) => provider.provider === 'claude',
  );
  assert.equal(result.status, 'completed');
  assert.match(receipt, /secret/);
  assert.equal(fs.statSync(result.receiptPath).mode & 0o777, 0o600);
  assert.equal(privateProvider.target.command, process.execPath);
  assert.equal(privateProvider.target.env.CHATMUX_BROWSER_USE_MCP_TOKEN, 'secret');
  assert.equal(typeof privateProvider.expectedOwnershipFingerprint, 'string');
  assert.equal(JSON.stringify(result).includes('secret'), false);
});

test('classifies nonmatching same-name as user owned and completes noop', () => {
  const dir = home(); const config = path.join(dir, '.claude.json'); write(config, JSON.stringify({ mcpServers: { 'chatmux-browser': { command: 'mine', args: [] } } }));
  const result = service(dir).apply(); assert.equal(result.status, 'completed_noop'); assert.match(fs.readFileSync(config, 'utf8'), /mine/);
});

test('partial and parse errors block every provider write', () => {
  const dir = home(); const exact = path.join(dir, '.claude.json'); write(exact, managed()); write(path.join(dir, '.cursor/mcp.json'), '{ invalid');
  const result = service(dir).apply(); assert.equal(result.status, 'blocked'); assert.match(fs.readFileSync(exact, 'utf8'), /chatmux-browser/);
});

test('rejects live servers, unsafe ownership modes, symlinks, and existing locks without provider writes', () => {
  const dir = home(); const config = path.join(dir, '.claude.json'); write(config, managed());
  assert.throws(() => new ChatmuxBrowserMcpCleanupService({ homeDir: dir, isLiveServer: () => true }).apply()); assert.match(fs.readFileSync(config, 'utf8'), /chatmux-browser/);
  const unsafe = home(); const unsafeConfig = path.join(unsafe, '.claude.json'); write(unsafeConfig, managed()); fs.chmodSync(unsafeConfig, 0o666); assert.equal(service(unsafe).apply().status, 'blocked');
  const linked = home(); write(path.join(linked, 'real.json'), managed()); fs.symlinkSync(path.join(linked, 'real.json'), path.join(linked, '.claude.json')); assert.equal(service(linked).apply().status, 'blocked');
  const locked = home(); const root = path.join(locked, '.chatmux/data/migrations/browser-mcp-cleanup'); fs.mkdirSync(root, { recursive: true, mode: 0o700 }); write(path.join(root, 'migration.lock'), 'held'); assert.throws(() => service(locked).apply());
});

test('default live-server probe rejects a ChatMux health endpoint without a live marker', async () => {
  const dir = home();
  const config = path.join(dir, '.claude.json');
  write(config, managed());
  const { child, port } = await startHealthServer();
  try {
    const cleanup = new ChatmuxBrowserMcpCleanupService({
      homeDir: dir,
      serverScriptPath: '/opt/chatmux/server/browser-use-mcp.js',
      port,
      token: () => 'secret',
      randomUUID: runId,
    });
    assert.throws(() => cleanup.apply(), /appears live/);
    assert.match(fs.readFileSync(config, 'utf8'), /chatmux-browser/);
  } finally {
    child.kill('SIGTERM');
  }
});
test('compensates an apply rename when its directory fsync fails', () => {
  const dir = home();
  const config = path.join(dir, '.claude.json');
  write(config, managed());
  const originalFsync = fs.fsyncSync;
  let failed = false;
  fs.fsyncSync = ((descriptor: number) => {
    if (!failed
      && fs.fstatSync(descriptor).isDirectory()
      && fs.readlinkSync(`/proc/self/fd/${descriptor}`) === dir) {
      failed = true;
      throw new Error('injected post-rename directory fsync failure');
    }
    return originalFsync(descriptor);
  }) as typeof fs.fsyncSync;
  try {
    assert.equal(service(dir).apply().status, 'failed_compensated');
  } finally {
    fs.fsyncSync = originalFsync;
  }
  assert.equal(failed, true);
  assert.ok(JSON.parse(fs.readFileSync(config, 'utf8')).mcpServers['chatmux-browser']);
});

test('rollback restores preimage and detects conflicts before restoring any provider', () => {
  const dir = home(); const config = path.join(dir, '.claude.json'); const before = managed(); write(config, before); const result = service(dir).apply();
  assert.equal(service(dir).rollback(result.runId).status, 'rolled_back'); assert.equal(fs.readFileSync(config, 'utf8'), before); assert.equal(fs.statSync(config).mode & 0o777, 0o600);
  const second = service(dir).apply(); fs.writeFileSync(config, '{}'); assert.equal(service(dir).rollback(second.runId).status, 'rollback_conflict'); assert.equal(fs.readFileSync(config, 'utf8'), '{}');
});

test('apply failure on a later provider compensates every earlier provider', () => {
  const dir = home();
  const claude = path.join(dir, '.claude.json');
  const cursor = path.join(dir, '.cursor/mcp.json');
  write(claude, managed());
  write(cursor, managed());
  const originalRename = fs.renameSync;
  let failed = false;
  fs.renameSync = ((source: fs.PathLike, destination: fs.PathLike) => {
    if (!failed && String(destination) === cursor) {
      failed = true;
      throw new Error('injected cursor write failure');
    }
    return originalRename(source, destination);
  }) as typeof fs.renameSync;
  try {
    assert.equal(service(dir).apply().status, 'failed_compensated');
  } finally {
    fs.renameSync = originalRename;
  }
  assert.ok(JSON.parse(fs.readFileSync(claude, 'utf8')).mcpServers['chatmux-browser']);
  assert.ok(JSON.parse(fs.readFileSync(cursor, 'utf8')).mcpServers['chatmux-browser']);
});

test('rollback failure on a later restore compensates earlier restores forward', () => {
  const dir = home();
  const claude = path.join(dir, '.claude.json');
  const cursor = path.join(dir, '.cursor/mcp.json');
  write(claude, managed());
  write(cursor, managed());
  const applied = service(dir).apply();
  assert.equal(applied.status, 'completed');

  const originalRename = fs.renameSync;
  let failed = false;
  fs.renameSync = ((source: fs.PathLike, destination: fs.PathLike) => {
    if (!failed && String(destination) === claude) {
      failed = true;
      throw new Error('injected claude restore failure');
    }
    return originalRename(source, destination);
  }) as typeof fs.renameSync;
  try {
    assert.equal(service(dir).rollback(applied.runId).status, 'failed_compensated');
  } finally {
    fs.renameSync = originalRename;
  }
  assert.equal(JSON.parse(fs.readFileSync(claude, 'utf8')).mcpServers['chatmux-browser'], undefined);
  assert.equal(JSON.parse(fs.readFileSync(cursor, 'utf8')).mcpServers['chatmux-browser'], undefined);
});
test('forward-compensates a rollback rename when its directory fsync fails', () => {
  const dir = home();
  const config = path.join(dir, '.claude.json');
  write(config, managed());
  const applied = service(dir).apply();
  const originalFsync = fs.fsyncSync;
  let failed = false;
  fs.fsyncSync = ((descriptor: number) => {
    if (!failed
      && fs.fstatSync(descriptor).isDirectory()
      && fs.readlinkSync(`/proc/self/fd/${descriptor}`) === dir) {
      failed = true;
      throw new Error('injected post-rename directory fsync failure');
    }
    return originalFsync(descriptor);
  }) as typeof fs.fsyncSync;
  try {
    assert.equal(service(dir).rollback(applied.runId).status, 'failed_compensated');
  } finally {
    fs.fsyncSync = originalFsync;
  }
  assert.equal(failed, true);
  assert.equal(JSON.parse(fs.readFileSync(config, 'utf8')).mcpServers['chatmux-browser'], undefined);
});

test('TOML dedicated blocks are handled while inline TOML is blocked', () => {
  const dir = home(); const toml = path.join(dir, '.codex/config.toml'); write(toml, `[mcp_servers.chatmux-browser]\ncommand = "${process.execPath}"\nargs = ["/opt/chatmux/server/browser-use-mcp.js"]\nenv_vars = []\n[mcp_servers.chatmux-browser.env]\nCHATMUX_BROWSER_USE_MCP_TOKEN = "secret"\nCHATMUX_BROWSER_USE_API_URL = "http://127.0.0.1:3001/api/browser-use-mcp"\n`);
  assert.equal(service(dir).apply().status, 'completed');
  const inline = home(); write(path.join(inline, '.codex/config.toml'), 'mcp_servers.chatmux-browser.command = "x"\n'); assert.equal(service(inline).apply().status, 'blocked');
});
test('uses a read-only custom database token and configured port', () => {
  const dir = home();
  const databasePath = path.join(dir, 'custom', 'auth.db');
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const database = new Database(databasePath);
  database.exec('CREATE TABLE app_config (key TEXT PRIMARY KEY, value TEXT)');
  database.prepare('INSERT INTO app_config (key, value) VALUES (?, ?)').run('browser_use_mcp_token', 'db-secret');
  database.close();
  const script = path.join(findServerRoot(getModuleDir(import.meta.url)), 'browser-use-mcp.js');
  write(path.join(dir, '.claude.json'), managed(script, 'db-secret', '4123'));
  const previousDatabasePath = process.env.DATABASE_PATH;
  const previousPort = process.env.SERVER_PORT;
  try {
    process.env.DATABASE_PATH = databasePath;
    process.env.SERVER_PORT = '4123';
    assert.equal(new ChatmuxBrowserMcpCleanupService({
      homeDir: dir, isLiveServer: () => false, randomUUID: runId,
    }).apply().status, 'completed');
  } finally {
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    if (previousPort === undefined) delete process.env.SERVER_PORT;
    else process.env.SERVER_PORT = previousPort;
  }
});
test('fails closed without creating a nonexistent token database', () => {
  const dir = home();
  const databasePath = path.join(dir, 'missing', 'auth.db');
  const script = path.join(findServerRoot(getModuleDir(import.meta.url)), 'browser-use-mcp.js');
  const config = path.join(dir, '.claude.json');
  write(config, managed(script, 'missing-token'));
  const previousDatabasePath = process.env.DATABASE_PATH;
  try {
    process.env.DATABASE_PATH = databasePath;
    assert.equal(new ChatmuxBrowserMcpCleanupService({
      homeDir: dir, isLiveServer: () => false, randomUUID: runId,
    }).apply().status, 'blocked');
    assert.equal(fs.existsSync(path.dirname(databasePath)), false);
    assert.match(fs.readFileSync(config, 'utf8'), /chatmux-browser/);
  } finally {
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
  }
});
