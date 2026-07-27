import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import bcrypt from 'bcrypt';

import {
  assertVpnBindHost,
  buildManagedEnvironment,
  parseInstallOptions,
  runAccessCli,
  selectAvailableServerPort,
  renderSystemdUnit,
  runInstallCli,
} from './install-cli.js';
import { chooseServePort, parseServePorts } from './tailscale-access.js';

test('install options are fixed to one local-only shape with a validated port', () => {
  assert.deepEqual(parseInstallOptions(['--yes', '--port=3010']), {
    yes: true,
    dryRun: false,
    serverPort: 3010,
    serverPortExplicit: true,
  });
  assert.throws(() => parseInstallOptions(['--port=0']), /between 1 and 65535/);
  assert.throws(() => parseInstallOptions(['--unknown']), /Unknown install option/);
  // The old access-mode flags fail closed with the replacement command.
  for (const removed of ['--tailscale', '--local', '--vpn', '--vpn=10.0.0.1', '--owner', '--owner=a@b.c', '--https-port']) {
    assert.throws(
      () => parseInstallOptions([removed]),
      /always local-only.*chatmux access enable/s,
      removed,
    );
  }
});

test('VPN bind addresses must be private IPv4 addresses present on a local interface', () => {
  const interfaces = () => ({
    wg0: [{ address: '10.11.0.1' }],
    lo: [{ address: '127.0.0.1' }],
  }) as never;
  assert.equal(assertVpnBindHost('10.11.0.1', interfaces), '10.11.0.1');
  assert.equal(assertVpnBindHost(' 10.11.0.1 ', interfaces), '10.11.0.1');
  assert.throws(() => assertVpnBindHost('not-an-ip', interfaces), /IPv4 address/);
  assert.throws(() => assertVpnBindHost('203.0.113.7', interfaces), /private tunnel addresses/);
  assert.throws(() => assertVpnBindHost('10.99.0.1', interfaces), /No local network interface/);
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
  await runInstallCli(['--yes', '--dry-run'], {
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
  assert.deepEqual(commands, []);
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
  const binPath = path.join(home, '.local', 'bin', 'chatmux');
  await fs.mkdir(path.dirname(binPath), { recursive: true });
  await fs.symlink('/legacy/chatmux-runtime.mjs', binPath);
  // A previous remote-access mode must be replaced by the password default.
  await fs.mkdir(path.join(home, '.chatmux'), { recursive: true });
  await fs.writeFile(path.join(home, '.chatmux', 'chatmux.env'), [
    'CHATMUX_AUTH=tailscale',
    'SERVER_PORT=39101',
    'DATABASE_PATH="/ignored"',
    '',
  ].join('\n'));

  await runInstallCli(['--yes', '--port=39101'], {
    appRoot: process.cwd(),
    version: 'test',
    home,
    platform: 'linux',
    arch: 'x64',
    nodeVersion: '22.22.2',
    nodeBinary: '/opt/chatmux node/bin/node',
    // No non-internal interface → no Phone/QR lines, keeping commands exact.
    interfaces: () => ({ lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }] }) as never,
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
  assert.match(environment, /^CHATMUX_AUTH=password$/m);
  assert.doesNotMatch(environment, /CHATMUX_ALLOW_UNAUTH_REMOTE/);
  assert.match(unit, /Environment=HOST=0\.0\.0\.0/);
  assert.match(unit, /Environment=SERVER_PORT=39101/);
  assert.equal(await fs.realpath(path.join(home, '.chatmux', 'current')), process.cwd());
  const cli = await fs.readFile(binPath, 'utf8');
  assert.equal(cli, [
    '#!/bin/sh',
    '# Managed by ChatMux installer',
    `CHATMUX_ENV_FILE='${path.join(home, '.chatmux', 'chatmux.env')}' exec '/opt/chatmux node/bin/node' '${path.join(home, '.chatmux', 'current', 'scripts', 'chatmux-runtime.mjs')}' "$@"`,
    '',
  ].join('\n'));
  assert.equal((await fs.stat(binPath)).mode & 0o777, 0o755);
  assert.deepEqual(commands, [
    'systemctl --user stop chatmux.service',
    'systemctl --user daemon-reload',
    'systemctl --user enable chatmux.service',
    'systemctl --user restart chatmux.service',
  ]);

  // The owner account exists before the service ever binds beyond loopback,
  // and a reinstall must keep it instead of minting a new credential.
  const { initializeDatabase, closeConnection, userDb } = await import('@/modules/database/index.js');
  await initializeDatabase();
  const owner = userDb.getFirstUser();
  assert.equal(owner?.username, 'owner');
  closeConnection();

  await runInstallCli(['--yes', '--port=39101'], {
    appRoot: process.cwd(),
    version: 'test',
    home,
    platform: 'linux',
    arch: 'x64',
    nodeVersion: '22.22.2',
    nodeBinary: '/opt/chatmux node/bin/node',
    interfaces: () => ({}) as never,
    healthCheck: async () => {},
    run: async () => ({ stdout: '', stderr: '' }),
  });
  await initializeDatabase();
  assert.equal(userDb.getFirstUser()?.id, owner?.id);
  closeConnection();
});

test('access enable vpn rebinds the unit and enable tailscale restores loopback', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmux-access-vpn-'));
  const savedEnvironment: Record<string, string | undefined> = {};
  for (const key of ['DATABASE_PATH', 'SERVER_PORT', 'CHATMUX_AUTH', 'CHATMUX_ALLOW_UNAUTH_REMOTE']) {
    savedEnvironment[key] = process.env[key];
    delete process.env[key];
  }
  t.after(async () => {
    for (const [key, value] of Object.entries(savedEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(home, { recursive: true, force: true });
  });

  const configPath = path.join(home, '.chatmux', 'chatmux.env');
  const unitPath = path.join(home, '.config', 'systemd', 'user', 'chatmux.service');
  await fs.mkdir(path.join(home, '.chatmux', 'data'), { recursive: true });
  await fs.mkdir(path.dirname(unitPath), { recursive: true });
  await fs.writeFile(configPath, [
    'CHATMUX_AUTH=none',
    'SERVER_PORT=39104',
    `DATABASE_PATH="${path.join(home, '.chatmux', 'data', 'auth.db')}"`,
    '',
  ].join('\n'));
  await fs.writeFile(unitPath, [
    '[Service]',
    'Environment=HOST=127.0.0.1',
    'Environment=SERVER_PORT=39104',
    '',
  ].join('\n'));

  const commands: string[] = [];
  const run = async (command: string, args: string[]) => {
    commands.push([command, ...args].join(' '));
    return { stdout: '', stderr: '' };
  };
  const interfaces = () => ({ wg0: [{ address: '10.11.0.2' }] }) as never;

  await runAccessCli(['enable', 'vpn', '10.11.0.2'], { home, run, interfaces });

  let environment = await fs.readFile(configPath, 'utf8');
  let unit = await fs.readFile(unitPath, 'utf8');
  assert.match(environment, /^CHATMUX_AUTH=none$/m);
  assert.match(environment, /^CHATMUX_ALLOW_UNAUTH_REMOTE=1$/m);
  assert.match(unit, /^Environment=HOST=10\.11\.0\.2$/m);
  assert.deepEqual(commands, [
    'systemctl --user daemon-reload',
    'systemctl --user restart chatmux.service',
    'qrencode -t ANSIUTF8 http://10.11.0.2:39104',
  ]);

  // Switching back to Tailscale must restore the loopback bind and drop the
  // unauthenticated-remote override.
  commands.length = 0;
  const statusJson = JSON.stringify({
    BackendState: 'Running',
    Self: { DNSName: 'host.example.ts.net.', UserID: 42 },
    User: { 42: { LoginName: 'owner@example.com' } },
  });
  let configured = false;
  await runAccessCli(['enable', 'tailscale'], {
    home,
    interfaces,
    run: async (command, args) => {
      commands.push([command, ...args].join(' '));
      if (command !== 'tailscale') return { stdout: '', stderr: '' };
      if (args[0] === 'status') return { stdout: statusJson, stderr: '' };
      if (args.includes('--json')) return { stdout: JSON.stringify({ TCP: {} }), stderr: '' };
      if (args[0] === 'serve' && args.includes('--bg')) {
        configured = true;
        return { stdout: '', stderr: '' };
      }
      return {
        stdout: configured
          ? 'https://host.example.ts.net:8443 (tailnet only)\n|-- / proxy http://127.0.0.1:39104\n'
          : 'no serve config\n',
        stderr: '',
      };
    },
  });

  environment = await fs.readFile(configPath, 'utf8');
  unit = await fs.readFile(unitPath, 'utf8');
  assert.match(environment, /^CHATMUX_AUTH=tailscale$/m);
  assert.doesNotMatch(environment, /CHATMUX_ALLOW_UNAUTH_REMOTE/);
  assert.match(unit, /^Environment=HOST=127\.0\.0\.1$/m);

  await assert.rejects(
    runAccessCli(['enable', 'vpn', '10.99.0.9'], { home, run, interfaces }),
    /No local network interface/,
  );
});
test('access enable password walks setup on loopback first, then opens the requested bind', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmux-access-password-'));
  const savedEnvironment: Record<string, string | undefined> = {};
  for (const key of ['DATABASE_PATH', 'SERVER_PORT', 'CHATMUX_AUTH', 'CHATMUX_ALLOW_UNAUTH_REMOTE', 'CHATMUX_SESSION_DAYS']) {
    savedEnvironment[key] = process.env[key];
    delete process.env[key];
  }
  t.after(async () => {
    for (const [key, value] of Object.entries(savedEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(home, { recursive: true, force: true });
  });

  const configPath = path.join(home, '.chatmux', 'chatmux.env');
  const unitPath = path.join(home, '.config', 'systemd', 'user', 'chatmux.service');
  const databasePath = path.join(home, '.chatmux', 'data', 'auth.db');
  await fs.mkdir(path.dirname(databasePath), { recursive: true });
  await fs.mkdir(path.dirname(unitPath), { recursive: true });
  await fs.writeFile(configPath, [
    'CHATMUX_AUTH=none',
    'SERVER_PORT=39105',
    `DATABASE_PATH="${databasePath}"`,
    '',
  ].join('\n'));
  await fs.writeFile(unitPath, [
    '[Service]',
    'Environment=HOST=127.0.0.1',
    'Environment=SERVER_PORT=39105',
    '',
  ].join('\n'));

  const commands: string[] = [];
  const run = async (command: string, args: string[]) => {
    commands.push([command, ...args].join(' '));
    return { stdout: '', stderr: '' };
  };
  const interfaces = () => ({
    lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    eth0: [{ address: '192.168.0.7', family: 'IPv4', internal: false }],
  }) as never;

  // Phase 1: no account yet — auth flips to password but the bind fails
  // closed to loopback so the owner can register locally.
  await runAccessCli(['enable', 'password', '--session-days', '90'], { home, run, interfaces });
  let environment = await fs.readFile(configPath, 'utf8');
  let unit = await fs.readFile(unitPath, 'utf8');
  assert.match(environment, /^CHATMUX_AUTH=password$/m);
  assert.match(environment, /^CHATMUX_SESSION_DAYS=90$/m);
  assert.match(unit, /^Environment=HOST=127\.0\.0\.1$/m);
  assert.ok(!commands.some((command) => command.startsWith('qrencode')));

  // Phase 2: with the owner account created, the requested bind opens and the
  // persisted session length survives without repeating the flag.
  const { initializeDatabase, closeConnection, userDb } = await import('@/modules/database/index.js');
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();
  userDb.createUser('owner', 'sentinel-hash');
  closeConnection();

  commands.length = 0;
  await runAccessCli(['enable', 'password'], { home, run, interfaces });
  environment = await fs.readFile(configPath, 'utf8');
  unit = await fs.readFile(unitPath, 'utf8');
  assert.match(environment, /^CHATMUX_AUTH=password$/m);
  assert.match(environment, /^CHATMUX_SESSION_DAYS=90$/m);
  assert.match(unit, /^Environment=HOST=0\.0\.0\.0$/m);
  assert.ok(commands.includes('qrencode -t ANSIUTF8 http://192.168.0.7:39105'));

  await assert.rejects(
    runAccessCli(['enable', 'password', 'not-an-ip'], { home, run, interfaces }),
    /IPv4 bind address/,
  );
  await assert.rejects(
    runAccessCli(['enable', 'password', '--session-days', '0'], { home, run, interfaces }),
    /between 1 and 365/,
  );
});

test('access password rotates the owner credential and revokes existing sessions', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmux-access-rotate-'));
  const savedEnvironment: Record<string, string | undefined> = {};
  for (const key of ['DATABASE_PATH', 'SERVER_PORT', 'CHATMUX_AUTH']) {
    savedEnvironment[key] = process.env[key];
    delete process.env[key];
  }
  t.after(async () => {
    for (const [key, value] of Object.entries(savedEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(home, { recursive: true, force: true });
  });

  const databasePath = path.join(home, '.chatmux', 'data', 'auth.db');
  await fs.mkdir(path.dirname(databasePath), { recursive: true });
  await fs.writeFile(path.join(home, '.chatmux', 'chatmux.env'), [
    'CHATMUX_AUTH=password',
    'SERVER_PORT=39106',
    `DATABASE_PATH="${databasePath}"`,
    '',
  ].join('\n'));

  const { initializeDatabase, closeConnection, userDb } = await import('@/modules/database/index.js');
  const { appConfigDb } = await import('@/modules/database/repositories/app-config.js');
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();
  const created = userDb.createUser('owner', 'sentinel-hash');
  closeConnection();

  const run = async () => ({ stdout: '', stderr: '' });
  await assert.rejects(runAccessCli(['password', 'short'], { home, run }), /at least 6 characters/);
  await runAccessCli(['password', 'rotated-secret'], { home, run });

  await initializeDatabase();
  const row = userDb.getUserByUsername('owner');
  assert.ok(row);
  assert.notEqual(row.password_hash, 'sentinel-hash');
  assert.equal(await bcrypt.compare('rotated-secret', row.password_hash), true);
  // The token-version bump signs out every session issued before the change.
  assert.equal(appConfigDb.get(`auth_token_version:${created.id}`), '1');
  closeConnection();
});
