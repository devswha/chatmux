import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import { createServer } from 'node:net';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';

import { closeConnection, initializeDatabase } from '@/modules/database/index.js';
import { appConfigDb } from '@/modules/database/repositories/app-config.js';
import {
  allowTailscaleUser,
  getTailscaleAccessConfig,
  normalizeTailscaleLogin,
  revokeTailscaleUser,
  setTailscaleOwner,
} from '@/tailscale-auth.js';
import {
  chooseServePort,
  parseServePorts,
  parseServeStatus,
  parseTailscaleSelfLogin,
  parseTailscaleStatus,
} from '@/tailscale-access.js';

const MANAGED_SERVE_PORT_KEY = 'tailscale_serve_https_port';
const DEFAULT_SERVER_PORT = 3001;

type CommandResult = { stdout: string; stderr: string };
type CommandRunner = (command: string, args: string[]) => Promise<CommandResult>;

type InstallOptions = {
  yes: boolean;
  dryRun: boolean;
  accessMode: 'auto' | 'local' | 'tailscale';
  owner: string | null;
  serverPort: number;
  serverPortExplicit: boolean;
  httpsPort: number | null;
};

type InstallContext = {
  appRoot: string;
  version: string;
  home?: string;
  run?: CommandRunner;
  platform?: NodeJS.Platform;
  arch?: string;
  nodeVersion?: string;
  healthCheck?: (serverPort: number, version: string) => Promise<void>;
  portAvailable?: (port: number) => Promise<boolean>;
};

function runCommand(command: string, args: string[]): Promise<CommandResult> {
  const { promise, resolve, reject } = Promise.withResolvers<CommandResult>();
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  const timer = setTimeout(() => {
    child.kill('SIGKILL');
    reject(new Error(`${command} timed out`));
  }, 30_000);
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
  child.once('error', (error) => {
    clearTimeout(timer);
    reject(error);
  });
  child.once('close', (code) => {
    clearTimeout(timer);
    if (code === 0) resolve({ stdout, stderr });
    else reject(new Error(`${command} ${args.join(' ')} failed: ${stderr.trim() || `exit ${code}`}`));
  });
  return promise;
}

function parsePort(value: string, option: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${option} must be an integer between 1 and 65535`);
  }
  return port;
}

export function parseInstallOptions(args: string[]): InstallOptions {
  const options: InstallOptions = {
    yes: false,
    dryRun: false,
    accessMode: 'auto',
    owner: null,
    serverPort: DEFAULT_SERVER_PORT,
    serverPortExplicit: false,
    httpsPort: null,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--yes' || arg === '-y') options.yes = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--tailscale') options.accessMode = 'tailscale';
    else if (arg === '--local') options.accessMode = 'local';
    else if (arg === '--owner') options.owner = args[++index] ?? null;
    else if (arg.startsWith('--owner=')) options.owner = arg.slice('--owner='.length);
    else if (arg === '--port') {
      options.serverPort = parsePort(args[++index] ?? '', '--port');
      options.serverPortExplicit = true;
    } else if (arg.startsWith('--port=')) {
      options.serverPort = parsePort(arg.slice('--port='.length), '--port');
      options.serverPortExplicit = true;
    }
    else if (arg === '--https-port') options.httpsPort = parsePort(args[++index] ?? '', '--https-port');
    else if (arg.startsWith('--https-port=')) options.httpsPort = parsePort(arg.slice('--https-port='.length), '--https-port');
    else throw new Error(`Unknown install option: ${arg}`);
  }
  return options;
}


function isPortAvailable(port: number): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const server = createServer();
  server.unref();
  server.once('error', () => resolve(false));
  server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
    server.close(() => resolve(true));
  });
  return promise;
}

export async function selectAvailableServerPort(
  requestedPort: number,
  explicit: boolean,
  available: (port: number) => Promise<boolean> = isPortAvailable,
): Promise<number> {
  if (await available(requestedPort)) return requestedPort;
  if (explicit) throw new Error(`Server port ${requestedPort} is already in use`);
  const finalCandidate = Math.min(65_535, requestedPort + 99);
  for (let port = requestedPort + 1; port <= finalCandidate; port += 1) {
    if (await available(port)) return port;
  }
  throw new Error(`No free server port is available from ${requestedPort} through ${finalCandidate}`);
}

function escapeSystemdPath(value: string): string {
  if (!path.isAbsolute(value)) throw new Error('Systemd paths must be absolute');
  if (/\r|\n|\0/.test(value)) throw new Error('Systemd paths cannot contain control characters');
  let escaped = '';
  for (const byte of Buffer.from(value, 'utf8')) {
    const character = String.fromCharCode(byte);
    if (/[A-Za-z0-9_./:@+-]/.test(character)) escaped += character;
    else if (character === '%') escaped += '%%';
    else escaped += `\\x${byte.toString(16).padStart(2, '0')}`;
  }
  return escaped;
}

export function renderSystemdUnit(template: string, values: {
  appRoot: string;
  workingDirectory: string;
  nodeBinary: string;
  configFile: string;
  host: string;
  port: number;
}): string {
  const replacements: Record<string, string> = {
    '@APP_ROOT@': escapeSystemdPath(values.appRoot),
    '@APP_ROOT_DIR@': escapeSystemdPath(values.workingDirectory),
    '@NODE_BIN@': escapeSystemdPath(values.nodeBinary),
    '@CONFIG_FILE@': escapeSystemdPath(values.configFile),
    '@HOST@': values.host,
    '@PORT@': String(values.port),
  };
  let rendered = template;
  for (const [placeholder, value] of Object.entries(replacements)) {
    rendered = rendered.replaceAll(placeholder, value);
  }
  if (/@[A-Z_]+@/.test(rendered)) throw new Error('Systemd template contains unresolved placeholders');
  return rendered;
}

export function buildManagedEnvironment(values: {
  authMode: 'none' | 'tailscale';
  databasePath: string;
  serverPort: number;
}): string {
  if (/\r|\n|\0/.test(values.databasePath)) throw new Error('Database path contains invalid characters');
  const escapedPath = values.databasePath.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
  return [
    `CHATMUX_AUTH=${values.authMode}`,
    `SERVER_PORT=${values.serverPort}`,
    `DATABASE_PATH="${escapedPath}"`,
    '',
  ].join('\n');
}

async function readManagedEnvironment(configPath: string): Promise<void> {
  try {
    const content = await fs.readFile(configPath, 'utf8');
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const separator = line.indexOf('=');
      if (separator < 1) continue;
      const key = line.slice(0, separator);
      let value = line.slice(separator + 1);
      if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1).replaceAll('\\"', '"').replaceAll('\\\\', '\\');
      if (!process.env[key]) process.env[key] = value;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function promptYesNo(question: string, defaultYes: boolean): Promise<boolean> {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const suffix = defaultYes ? '[Y/n]' : '[y/N]';
    const answer = (await terminal.question(`${question} ${suffix} `)).trim().toLowerCase();
    if (!answer) return defaultYes;
    return answer === 'y' || answer === 'yes';
  } finally {
    terminal.close();
  }
}

async function promptValue(question: string, defaultValue: string): Promise<string> {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await terminal.question(`${question} [${defaultValue}] `)).trim();
    return answer || defaultValue;
  } finally {
    terminal.close();
  }
}

function assertRuntime(context: Required<Pick<InstallContext, 'platform' | 'arch' | 'nodeVersion'>>): void {
  const [major, minor, patch] = context.nodeVersion.split('.').map(Number);
  if (context.platform !== 'linux' || context.arch !== 'x64') {
    throw new Error(`ChatMux managed install requires Linux x64; received ${context.platform} ${context.arch}`);
  }
  if (major !== 22 || minor < 22 || (minor === 22 && patch < 2)) {
    throw new Error(`ChatMux managed install requires Node.js 22.22.2+ (22.x); received ${context.nodeVersion}`);
  }
}

async function replaceManagedSymlink(linkPath: string, targetPath: string, type?: 'dir'): Promise<void> {
  try {
    const existing = await fs.lstat(linkPath);
    if (!existing.isSymbolicLink()) {
      throw new Error(`Refusing to replace non-symlink path: ${linkPath}`);
    }
    await fs.rm(linkPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await fs.symlink(targetPath, linkPath, type);
}

async function waitForHealth(serverPort: number, version: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${serverPort}/health`);
      if (response.ok) {
        const payload = await response.json() as { product?: unknown; version?: unknown };
        if (payload.product === 'chatmux' && payload.version === version) return;
      }
    } catch {
      // The service may still be starting.
    }
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 500);
    await promise;
  }
  throw new Error(`ChatMux ${version} did not become healthy on 127.0.0.1:${serverPort}`);
}

async function inspectTailscale(run: CommandRunner): Promise<{
  installed: boolean;
  running: boolean;
  owner: string | null;
  statusJson: string;
}> {
  try {
    const { stdout } = await run('tailscale', ['status', '--json']);
    const status = parseTailscaleStatus(stdout);
    return {
      installed: true,
      running: status.running,
      owner: parseTailscaleSelfLogin(stdout),
      statusJson: stdout,
    };
  } catch {
    return { installed: false, running: false, owner: null, statusJson: '{}' };
  }
}

async function configureTailscaleServe(
  run: CommandRunner,
  serverPort: number,
  requestedHttpsPort: number | null,
): Promise<{ url: string; httpsPort: number; changed: boolean }> {
  const { stdout: statusJson } = await run('tailscale', ['serve', 'status', '--json']).catch(() => ({ stdout: '{}', stderr: '' }));
  const { stdout: statusText } = await run('tailscale', ['serve', 'status']).catch(() => ({ stdout: '', stderr: '' }));
  const existingUrls = parseServeStatus(statusText, serverPort);
  if (existingUrls.length > 0) {
    const existing = new URL(existingUrls[0]);
    const httpsPort = Number(existing.port || 443);
    return { url: existingUrls[0], httpsPort, changed: false };
  }

  const occupied = parseServePorts(statusJson);
  const preferred = requestedHttpsPort ?? chooseServePort(occupied);
  if (occupied.has(preferred)) {
    throw new Error(`Tailscale Serve HTTPS port ${preferred} is already used by another service`);
  }
  await run('tailscale', [
    'serve',
    '--bg',
    '--yes',
    `--https=${preferred}`,
    `http://127.0.0.1:${serverPort}`,
  ]);
  const { stdout: refreshed } = await run('tailscale', ['serve', 'status']);
  const [url] = parseServeStatus(refreshed, serverPort);
  if (!url) throw new Error('Tailscale Serve was configured but no matching HTTPS endpoint was found');
  return { url, httpsPort: preferred, changed: true };
}

export async function runInstallCli(args: string[], context: InstallContext): Promise<void> {
  const options = parseInstallOptions(args);
  const home = context.home ?? os.homedir();
  const run = context.run ?? runCommand;
  assertRuntime({
    platform: context.platform ?? process.platform,
    arch: context.arch ?? process.arch,
    nodeVersion: context.nodeVersion ?? process.versions.node,
  });

  const managedRoot = path.join(home, '.chatmux');
  const currentPath = path.join(managedRoot, 'current');
  const dataPath = path.join(managedRoot, 'data');
  const sourceRoot = await fs.realpath(context.appRoot);
  const databasePath = path.join(dataPath, 'auth.db');
  const configPath = path.join(managedRoot, 'chatmux.env');
  const unitPath = path.join(home, '.config', 'systemd', 'user', 'chatmux.service');
  const binPath = path.join(home, '.local', 'bin', 'chatmux');
  const tailscale = await inspectTailscale(run);

  let useTailscale = options.accessMode === 'tailscale';
  if (options.accessMode === 'auto') {
    useTailscale = options.yes
      ? tailscale.running
      : await promptYesNo('Use passwordless Tailscale access from your other devices?', tailscale.running);
  }
  if (useTailscale && (!tailscale.installed || !tailscale.running)) {
    throw new Error('Tailscale must be installed, running, and logged in before enabling remote access');
  }

  let owner = normalizeTailscaleLogin(options.owner ?? tailscale.owner);
  if (useTailscale && !owner && !options.yes) {
    owner = normalizeTailscaleLogin(await promptValue('Tailscale owner login', 'user@example.com'));
  }
  if (useTailscale && !owner) throw new Error('Could not determine the Tailscale owner login; pass --owner <login>');

  if (!options.dryRun) {
    await run('systemctl', ['--user', 'stop', 'chatmux.service']).catch(() => undefined);
    const requestedPort = options.serverPort;
    options.serverPort = await selectAvailableServerPort(
      requestedPort,
      options.serverPortExplicit,
      context.portAvailable,
    );
    if (options.serverPort !== requestedPort) {
      console.log(`Port ${requestedPort} is already in use; using ${options.serverPort}.`);
    }
  }

  const template = await fs.readFile(path.join(context.appRoot, 'packaging', 'systemd', 'chatmux.service'), 'utf8');
  const unit = renderSystemdUnit(template, {
    appRoot: currentPath,
    workingDirectory: currentPath,
    nodeBinary: process.execPath,
    configFile: configPath,
    host: '127.0.0.1',
    port: options.serverPort,
  });
  const environment = buildManagedEnvironment({
    authMode: useTailscale ? 'tailscale' : 'none',
    databasePath,
    serverPort: options.serverPort,
  });

  if (options.dryRun) {
    console.log(JSON.stringify({
      version: context.version,
      appRoot: sourceRoot,
      currentPath,
      unitPath,
      configPath,
      binPath,
      accessMode: useTailscale ? 'tailscale' : 'local',
      owner: useTailscale ? owner : null,
      serverPort: options.serverPort,
    }, null, 2));
    return;
  }

  await fs.mkdir(dataPath, { recursive: true, mode: 0o700 });
  await fs.mkdir(path.dirname(unitPath), { recursive: true });
  await fs.mkdir(path.dirname(binPath), { recursive: true });
  await replaceManagedSymlink(currentPath, sourceRoot, 'dir');
  await fs.writeFile(configPath, environment, { mode: 0o600 });
  await fs.writeFile(unitPath, unit, 'utf8');
  await replaceManagedSymlink(binPath, path.join(currentPath, 'scripts', 'chatmux-runtime.mjs'));

  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();
  if (owner) setTailscaleOwner(owner);

  await run('systemctl', ['--user', 'daemon-reload']);
  await run('systemctl', ['--user', 'enable', 'chatmux.service']);
  await run('systemctl', ['--user', 'restart', 'chatmux.service']);
  await (context.healthCheck ?? waitForHealth)(options.serverPort, context.version);

  let remoteUrl: string | null = null;
  if (useTailscale) {
    const serve = await configureTailscaleServe(run, options.serverPort, options.httpsPort);
    remoteUrl = serve.url;
    appConfigDb.set(MANAGED_SERVE_PORT_KEY, String(serve.httpsPort));
  }
  closeConnection();

  console.log('\nChatMux installation complete');
  console.log(`  Local:  http://127.0.0.1:${options.serverPort}`);
  if (remoteUrl) console.log(`  Remote: ${remoteUrl}`);
  console.log(`  Access: ${useTailscale ? `Tailscale (${owner})` : 'this computer only'}`);
  console.log(`  Manage: chatmux status | chatmux access users | journalctl --user -u chatmux.service`);
  if (remoteUrl) {
    try {
      const qr = await run('qrencode', ['-t', 'ANSIUTF8', remoteUrl]);
      if (qr.stdout.trim()) console.log(`\n${qr.stdout}`);
    } catch {
      console.log('  QR: install qrencode to print this address as a terminal QR code');
    }
  }
}

async function initializeManagedDatabase(home: string): Promise<string> {
  const configPath = path.join(home, '.chatmux', 'chatmux.env');
  await readManagedEnvironment(configPath);
  process.env.DATABASE_PATH ||= path.join(home, '.chatmux', 'data', 'auth.db');
  await initializeDatabase();
  return configPath;
}

async function updateManagedAuthMode(configPath: string, mode: 'none' | 'tailscale'): Promise<void> {
  const databasePath = process.env.DATABASE_PATH as string;
  const serverPort = parsePort(process.env.SERVER_PORT || String(DEFAULT_SERVER_PORT), 'SERVER_PORT');
  await fs.writeFile(
    configPath,
    buildManagedEnvironment({ authMode: mode, databasePath, serverPort }),
    { mode: 0o600 },
  );
}

export async function runAccessCli(args: string[], context: Pick<InstallContext, 'home' | 'run'> = {}): Promise<void> {
  const home = context.home ?? os.homedir();
  const run = context.run ?? runCommand;
  const [command, ...rest] = args;
  const configPath = await initializeManagedDatabase(home);
  try {
    if (command === 'users' || !command) {
      const config = getTailscaleAccessConfig();
      console.log(`Owner: ${config.owner ?? '(not set)'}`);
      for (const user of config.users) console.log(`- ${user}${user === config.owner ? ' (owner)' : ''}`);
      return;
    }
    if (command === 'owner') {
      const login = rest[0];
      if (!login) {
        console.log(getTailscaleAccessConfig().owner ?? '(not set)');
        return;
      }
      const config = setTailscaleOwner(login);
      console.log(`Tailscale owner: ${config.owner}`);
      return;
    }
    if (command === 'allow') {
      const config = allowTailscaleUser(rest[0]);
      console.log(`Allowed: ${rest[0]} (${config.users.length} total)`);
      return;
    }
    if (command === 'revoke') {
      const config = revokeTailscaleUser(rest[0]);
      console.log(`Revoked: ${rest[0]} (${config.users.length} total)`);
      return;
    }
    if (command === 'enable' && rest[0] === 'tailscale') {
      const status = await inspectTailscale(run);
      if (!status.running) throw new Error('Tailscale is not running or logged in');
      const owner = normalizeTailscaleLogin(rest[1] ?? status.owner);
      if (!owner) throw new Error('Could not determine the Tailscale owner login');
      setTailscaleOwner(owner);
      await updateManagedAuthMode(configPath, 'tailscale');
      const serverPort = Number(process.env.SERVER_PORT || DEFAULT_SERVER_PORT);
      const serve = await configureTailscaleServe(run, serverPort, null);
      appConfigDb.set(MANAGED_SERVE_PORT_KEY, String(serve.httpsPort));
      await run('systemctl', ['--user', 'restart', 'chatmux.service']);
      console.log(`Tailscale access enabled: ${serve.url}`);
      return;
    }
    throw new Error('Usage: chatmux access users | owner [login] | allow <login> | revoke <login> | enable tailscale [owner]');
  } finally {
    closeConnection();
  }
}
