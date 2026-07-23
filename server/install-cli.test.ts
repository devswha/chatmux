import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  buildManagedEnvironment,
  parseInstallOptions,
  selectAvailableServerPort,
  renderSystemdUnit,
  runInstallCli,
} from './install-cli.js';
import { chooseServePort, parseServePorts } from './tailscale-access.js';

test('install options select explicit access and validated ports', () => {
  assert.deepEqual(parseInstallOptions([
    '--yes',
    '--tailscale',
    '--owner', 'Owner@example.com',
    '--port=3010',
    '--https-port', '8451',
  ]), {
    yes: true,
    dryRun: false,
    accessMode: 'tailscale',
    owner: 'Owner@example.com',
    serverPort: 3010,
    serverPortExplicit: true,
    httpsPort: 8451,
  });
  assert.throws(() => parseInstallOptions(['--port=0']), /between 1 and 65535/);
  assert.throws(() => parseInstallOptions(['--unknown']), /Unknown install option/);
});

test('default server port selection skips unrelated listeners but explicit ports fail closed', async () => {
  const occupied = new Set([3001, 3002]);
  const available = async (port: number) => !occupied.has(port);
  assert.equal(await selectAvailableServerPort(3001, false, available), 3003);
  await assert.rejects(
    selectAvailableServerPort(3001, true, available),
    /Server port 3001 is already in use/,
  );
});

test('Serve port selection never overwrites an existing service', () => {
  const occupied = parseServePorts(JSON.stringify({ TCP: { 443: {}, 8443: {}, 8444: {} } }));
  assert.equal(chooseServePort(occupied), 8445);
  assert.equal(chooseServePort(occupied, 8460), 8460);
  assert.deepEqual([...parseServePorts('not-json')], []);
});

test('managed environment and systemd unit keep the backend loopback-only', () => {
  const environment = buildManagedEnvironment({
    authMode: 'tailscale',
    databasePath: '/home/user/.chatmux/data/auth.db',
    serverPort: 3001,
  });
  assert.match(environment, /^CHATMUX_AUTH=tailscale$/m);
  assert.match(environment, /^SERVER_PORT=3001$/m);
  assert.match(environment, /^DATABASE_PATH="\/home\/user\/\.chatmux\/data\/auth\.db"$/m);

  const rendered = renderSystemdUnit([
    'WorkingDirectory=@APP_ROOT_DIR@',
    'EnvironmentFile=-@CONFIG_FILE@',
    'Environment=HOST=@HOST@',
    'Environment=SERVER_PORT=@PORT@',
    'ExecStart=@NODE_BIN@ @APP_ROOT@/scripts/chatmux-runtime.mjs start',
  ].join('\n'), {
    appRoot: '/home/user/.chatmux/current',
    workingDirectory: '/home/user/.chatmux/current',
    nodeBinary: '/usr/bin/node',
    configFile: '/home/user/.chatmux/chatmux.env',
    host: '127.0.0.1',
    port: 3001,
  });
  assert.match(rendered, /Environment=HOST=127\.0\.0\.1/);
  assert.match(rendered, /EnvironmentFile=-\/home\/user\/\.chatmux\/chatmux\.env/);
  assert.match(rendered, /WorkingDirectory=\/home\/user\/\.chatmux\/current/);
  assert.match(rendered, /ExecStart=\/usr\/bin\/node \/home\/user\/\.chatmux\/current\/scripts/);
  assert.doesNotMatch(rendered, /@[A-Z_]+@/);
  const escaped = renderSystemdUnit('WorkingDirectory=@APP_ROOT_DIR@', {
    appRoot: '/home/test user/.chatmux/current',
    workingDirectory: '/home/test user/.chatmux/current',
    nodeBinary: '/home/test user/node',
    configFile: '/home/test user/chatmux.env',
    host: '127.0.0.1',
    port: 3001,
  });
  assert.equal(escaped, 'WorkingDirectory=/home/test\\x20user/.chatmux/current');
});

test('install dry-run computes a local plan without writing or invoking systemd', async () => {
  const commands: string[] = [];
  await runInstallCli(['--yes', '--local', '--dry-run'], {
    appRoot: process.cwd(),
    version: 'test',
    home: '/tmp/chatmux-install-dry-run-home',
    platform: 'linux',
    arch: 'x64',
    nodeVersion: '22.22.2',
    run: async (command, args) => {
      commands.push([command, ...args].join(' '));
      throw new Error('not installed');
    },
  });
  assert.deepEqual(commands, ['tailscale status --json']);
});

test('managed install writes a complete isolated service layout before enabling it', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmux-install-'));
  const originalDatabasePath = process.env.DATABASE_PATH;
  t.after(async () => {
    if (originalDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = originalDatabasePath;
    await fs.rm(home, { recursive: true, force: true });
  });
  const commands: string[] = [];

  await runInstallCli(['--yes', '--local', '--port=39101'], {
    appRoot: process.cwd(),
    version: 'test',
    home,
    platform: 'linux',
    arch: 'x64',
    nodeVersion: '22.22.2',
    healthCheck: async (port, version) => {
      assert.equal(port, 39101);
      assert.equal(version, 'test');
    },
    run: async (command, args) => {
      commands.push([command, ...args].join(' '));
      if (command === 'tailscale') throw new Error('not installed');
      return { stdout: '', stderr: '' };
    },
  });

  const environment = await fs.readFile(path.join(home, '.chatmux', 'chatmux.env'), 'utf8');
  const unit = await fs.readFile(path.join(home, '.config', 'systemd', 'user', 'chatmux.service'), 'utf8');
  assert.match(environment, /CHATMUX_AUTH=none/);
  assert.match(unit, /Environment=HOST=127\.0\.0\.1/);
  assert.match(unit, /Environment=SERVER_PORT=39101/);
  assert.equal(await fs.realpath(path.join(home, '.chatmux', 'current')), process.cwd());
  assert.equal(await fs.readlink(path.join(home, '.local', 'bin', 'chatmux')), path.join(home, '.chatmux', 'current', 'scripts', 'chatmux-runtime.mjs'));
  assert.deepEqual(commands, [
    'tailscale status --json',
    'systemctl --user stop chatmux.service',
    'systemctl --user daemon-reload',
    'systemctl --user enable chatmux.service',
    'systemctl --user restart chatmux.service',
  ]);
});

test('managed Tailscale install selects a free HTTPS front without replacing existing services', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmux-install-tailscale-'));
  const originalDatabasePath = process.env.DATABASE_PATH;
  t.after(async () => {
    if (originalDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = originalDatabasePath;
    await fs.rm(home, { recursive: true, force: true });
  });
  const commands: string[] = [];
  let configured = false;
  const statusJson = JSON.stringify({
    BackendState: 'Running',
    Self: { DNSName: 'host.example.ts.net.', UserID: 42 },
    User: { 42: { LoginName: 'owner@example.com' } },
  });

  await runInstallCli(['--yes', '--tailscale', '--port=39102'], {
    appRoot: process.cwd(),
    version: 'test',
    home,
    platform: 'linux',
    arch: 'x64',
    nodeVersion: '22.22.2',
    healthCheck: async () => {},
    run: async (command, args) => {
      commands.push([command, ...args].join(' '));
      if (command === 'qrencode') throw new Error('not installed');
      if (command !== 'tailscale') return { stdout: '', stderr: '' };
      if (args[0] === 'status') return { stdout: statusJson, stderr: '' };
      if (args.includes('--json')) {
        return { stdout: JSON.stringify({ TCP: { 8443: { HTTPS: true } } }), stderr: '' };
      }
      if (args[0] === 'serve' && args.includes('--bg')) {
        configured = true;
        return { stdout: '', stderr: '' };
      }
      return {
        stdout: configured
          ? 'https://host.example.ts.net:8444 (tailnet only)\n|-- / proxy http://127.0.0.1:39102\n'
          : 'no serve config\n',
        stderr: '',
      };
    },
  });

  const environment = await fs.readFile(path.join(home, '.chatmux', 'chatmux.env'), 'utf8');
  assert.match(environment, /^CHATMUX_AUTH=tailscale$/m);
  assert.match(environment, /^SERVER_PORT=39102$/m);
  assert.ok(commands.includes(
    'tailscale serve --bg --yes --https=8444 http://127.0.0.1:39102',
  ));
  assert.ok(!commands.some((command) => command.includes('serve reset')));
});
