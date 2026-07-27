import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import { createServer } from 'node:net';
import path from 'node:path';

import bcrypt from 'bcrypt';

import { closeConnection, initializeDatabase, userDb } from '@/modules/database/index.js';
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
const OWNER_USERNAME = 'owner';
const PASSWORD_HASH_ROUNDS = 12;
const DEFAULT_SERVER_PORT = 3001;

type CommandResult = { stdout: string; stderr: string };
type CommandRunner = (command: string, args: string[]) => Promise<CommandResult>;

type InstallOptions = {
  yes: boolean;
  dryRun: boolean;
  serverPort: number;
  serverPortExplicit: boolean;
};

type InstallContext = {
  appRoot: string;
  version: string;
  home?: string;
  run?: CommandRunner;
  platform?: NodeJS.Platform;
  arch?: string;
  nodeVersion?: string;
  nodeBinary?: string;
  healthCheck?: (serverPort: number, version: string) => Promise<void>;
  portAvailable?: (port: number) => Promise<boolean>;
  interfaces?: () => NodeJS.Dict<os.NetworkInterfaceInfo[]>;
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

// Installation is deliberately a single fixed shape: local-only on loopback.
// Remote access is enabled afterwards with `chatmux access enable
// tailscale|vpn <address>`, so every install behaves identically regardless
// of what happens to be running on the machine.
const REMOVED_ACCESS_OPTIONS = ['--tailscale', '--local', '--vpn', '--owner', '--https-port'];

export function parseInstallOptions(args: string[]): InstallOptions {
  const options: InstallOptions = {
    yes: false,
    dryRun: false,
    serverPort: DEFAULT_SERVER_PORT,
    serverPortExplicit: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--yes' || arg === '-y') options.yes = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--port') {
      options.serverPort = parsePort(args[++index] ?? '', '--port');
      options.serverPortExplicit = true;
    } else if (arg.startsWith('--port=')) {
      options.serverPort = parsePort(arg.slice('--port='.length), '--port');
      options.serverPortExplicit = true;
    }
    else if (REMOVED_ACCESS_OPTIONS.includes(arg) || REMOVED_ACCESS_OPTIONS.some((option) => arg.startsWith(`${option}=`))) {
      throw new Error(
        `${arg} was removed: installation is always local-only. After installing, enable remote access with ` +
        `"chatmux access enable tailscale" or "chatmux access enable vpn <address>".`,
      );
    }
    else throw new Error(`Unknown install option: ${arg}`);
  }
  return options;
}


// VPN access mode binds the backend to a WireGuard-style private tunnel
// address with no application login (CHATMUX_AUTH=none +
// CHATMUX_ALLOW_UNAUTH_REMOTE=1), so the address is required to be a private
// IPv4 that is actually present on a local interface. A public bind would be
// unauthenticated remote code execution.
export function assertVpnBindHost(
  host: string,
  interfaces: () => NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces,
): string {
  const trimmed = (host ?? '').trim();
  const octets = trimmed.split('.').map(Number);
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
    throw new Error(`--vpn requires the VPN interface IPv4 address (e.g. --vpn 10.0.0.1); received "${host}"`);
  }
  const [first, second] = octets;
  const isPrivate =
    first === 10 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168);
  if (!isPrivate) {
    throw new Error(
      `VPN mode disables login entirely, so it only binds private tunnel addresses ` +
      `(10/8, 100.64/10, 172.16/12, 192.168/16); received ${trimmed}`,
    );
  }
  const present = Object.values(interfaces()).some((entries) =>
    (entries ?? []).some((entry) => entry.address === trimmed));
  if (!present) {
    throw new Error(`No local network interface has the address ${trimmed}; bring the VPN up first (e.g. wg-quick up wg0)`);
  }
  return trimmed;
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
  authMode: 'none' | 'tailscale' | 'password';
  allowUnauthRemote?: boolean;
  sessionDays?: number | null;
  databasePath: string;
  serverPort: number;
}): string {
  if (/\r|\n|\0/.test(values.databasePath)) throw new Error('Database path contains invalid characters');
  const escapedPath = values.databasePath.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
  return [
    `CHATMUX_AUTH=${values.authMode}`,
    ...(values.allowUnauthRemote ? ['CHATMUX_ALLOW_UNAUTH_REMOTE=1'] : []),
    ...(values.sessionDays ? [`CHATMUX_SESSION_DAYS=${values.sessionDays}`] : []),
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

const MANAGED_CLI_MARKER = '# Managed by ChatMux installer';

function quoteShellArgument(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function writeManagedCli(
  binPath: string,
  nodeBinary: string,
  currentPath: string,
  configPath: string,
): Promise<void> {
  try {
    const existing = await fs.lstat(binPath);
    if (!existing.isSymbolicLink()) {
      if (!existing.isFile()) throw new Error(`Refusing to replace non-file path: ${binPath}`);
      const content = await fs.readFile(binPath, 'utf8');
      if (!content.includes(MANAGED_CLI_MARKER)) {
        throw new Error(`Refusing to replace unmanaged file: ${binPath}`);
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const runtimeScript = path.join(currentPath, 'scripts', 'chatmux-runtime.mjs');
  const wrapper = [
    '#!/bin/sh',
    MANAGED_CLI_MARKER,
    `CHATMUX_ENV_FILE=${quoteShellArgument(configPath)} exec ${quoteShellArgument(nodeBinary)} ${quoteShellArgument(runtimeScript)} "$@"`,
    '',
  ].join('\n');
  const temporaryPath = `${binPath}.tmp-${process.pid}`;
  try {
    await fs.writeFile(temporaryPath, wrapper, { mode: 0o755 });
    await fs.rename(temporaryPath, binPath);
  } finally {
    await fs.rm(temporaryPath, { force: true });
  }
}

async function waitForHealth(serverPort: number, version: string, host = '127.0.0.1'): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://${host}:${serverPort}/health`);
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
  throw new Error(`ChatMux ${version} did not become healthy on ${host}:${serverPort}`);
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
  const nodeBinary = context.nodeBinary ?? process.execPath;

  // Detection is advisory only: a running tailnet changes the wording of the
  // "Reach" hint, never the installed mode.
  const tailscaleAlreadyRunning = (await inspectTailscale(run)).running;

  // Install is one fixed shape: loopback bind, no application login required
  // locally. Detect a previously configured remote mode only to tell the
  // operator how to restore it after this reset.
  let previousRemoteMode: 'tailscale' | 'vpn' | null = null;
  try {
    const previousEnvironment = await fs.readFile(configPath, 'utf8');
    if (/^CHATMUX_ALLOW_UNAUTH_REMOTE=1$/m.test(previousEnvironment)) previousRemoteMode = 'vpn';
    else if (/^CHATMUX_AUTH=tailscale$/m.test(previousEnvironment)) previousRemoteMode = 'tailscale';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

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
    nodeBinary,
    configFile: configPath,
    host: '0.0.0.0',
    port: options.serverPort,
  });
  const environment = buildManagedEnvironment({
    authMode: 'password',
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
  await writeManagedCli(binPath, nodeBinary, currentPath, configPath);

  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  // Phone-ready out of the box: create the owner account before the service
  // ever binds beyond loopback, so the exposure guard's fail-closed rule
  // ("no users → no network bind") is satisfied without a setup round-trip.
  // The generated password is printed exactly once below.
  let initialPassword: string | null = null;
  if (!userDb.hasUsers()) {
    initialPassword = generateInitialPassword();
    userDb.createUser(OWNER_USERNAME, await bcrypt.hash(initialPassword, PASSWORD_HASH_ROUNDS));
  }
  const ownerUsername = userDb.getFirstUser()?.username ?? OWNER_USERNAME;

  await run('systemctl', ['--user', 'daemon-reload']);
  await run('systemctl', ['--user', 'enable', 'chatmux.service']);
  await run('systemctl', ['--user', 'restart', 'chatmux.service']);
  await (context.healthCheck ?? waitForHealth)(options.serverPort, context.version);

  closeConnection();

  const lanAddresses = listLanAddresses(context.interfaces ?? os.networkInterfaces);
  const [primaryLan, ...alternateLans] = lanAddresses;
  console.log('\nChatMux installation complete');
  console.log(`  Local:  http://127.0.0.1:${options.serverPort}`);
  if (primaryLan) {
    console.log(`  Phone:  http://${primaryLan.address}:${options.serverPort} — same Wi-Fi: sign in from any browser, no app needed`);
  }
  if (alternateLans.length > 0) {
    console.log(`  Also:   ${alternateLans.map((entry) => `http://${entry.address}:${options.serverPort} (${entry.interfaceName})`).join(' · ')} — reachable while that VPN is connected`);
  }
  if (primaryLan) {
    // The one decision a first-time user faces after install. Keep it to the
    // two paths that actually work, with their real cost stated. When
    // Tailscale is already up, name it as the ready next step instead — the
    // install never switches modes on its own (see docs/REMOTE-ACCESS.md).
    console.log(tailscaleAlreadyRunning
      ? `  Reach:  Tailscale is already running here — "chatmux access enable tailscale" gives an HTTPS address that works from anywhere, including mobile data`
      : `  Reach:  from outside this Wi-Fi — "chatmux access enable tailscale" (free account + phone app; adds HTTPS, so notifications and home-screen install work), or forward TCP ${options.serverPort} on the router`);
  }
  if (await isUfwEnabled()) {
    console.log(`  Note:   the ufw firewall is enabled — phones stay blocked until you run: sudo ufw allow ${options.serverPort}/tcp`);
  }
  if (initialPassword) {
    console.log(`  Login:  ${ownerUsername} / ${initialPassword}`);
    console.log('          (shown only this once — change it with: chatmux access password)');
  } else {
    console.log(`  Login:  existing account "${ownerUsername}" (forgot it? chatmux access password)`);
  }
  console.log('  Access: password — one sign-in stays valid while you keep using it');
  console.log(`  Manage: chatmux status | chatmux access password | journalctl --user -u chatmux.service`);
  if (previousRemoteMode) {
    const restore = previousRemoteMode === 'vpn' ? 'chatmux access enable vpn <address>' : 'chatmux access enable tailscale';
    console.log(`  Note:   previous ${previousRemoteMode} remote access was replaced by password access; restore it with: ${restore}`);
  }
  if (primaryLan) {
    await printAccessQr(run, `http://${primaryLan.address}:${options.serverPort}`);
  }
}

async function initializeManagedDatabase(home: string): Promise<string> {
  const configPath = path.join(home, '.chatmux', 'chatmux.env');
  await readManagedEnvironment(configPath);
  process.env.DATABASE_PATH ||= path.join(home, '.chatmux', 'data', 'auth.db');
  await initializeDatabase();
  return configPath;
}

// Password mode binds are only constrained to valid IPv4 syntax: 0.0.0.0 (all
// interfaces) and LAN addresses are both legitimate because the application
// login protects the port. The exposure guard still fail-closes at startup
// when no account exists.
export function assertPasswordBindHost(host: string): string {
  const trimmed = (host ?? '').trim();
  const octets = trimmed.split('.').map(Number);
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
    throw new Error(`enable password requires an IPv4 bind address (e.g. 0.0.0.0); received "${host}"`);
  }
  return trimmed;
}

// 16-character base64url password from CSPRNG bytes: strong enough to guard a
// shell-capable port, short enough to retype on a phone once.
function generateInitialPassword(): string {
  return randomBytes(12).toString('base64url');
}

type LanAddress = { address: string; interfaceName: string };

// Container plumbing (docker bridges, veth pairs, …) is never reachable from
// a phone, so it is excluded outright. Tunnel interfaces (WireGuard,
// Tailscale, tun) only work for peers already inside that tunnel, so the
// physical LAN address is listed first as the primary and tunnels follow as
// labelled alternatives.
const CONTAINER_INTERFACE_PATTERN = /^(docker|br-|veth|virbr|lxc|lxd|cni|podman)/;
const TUNNEL_INTERFACE_PATTERN = /^(wg|tailscale|tun|tap|zt|utun|nebula)/;

export function listLanAddresses(interfaces: () => NodeJS.Dict<os.NetworkInterfaceInfo[]>): LanAddress[] {
  const entries = Object.entries(interfaces()).flatMap(([interfaceName, rows]) =>
    CONTAINER_INTERFACE_PATTERN.test(interfaceName)
      ? []
      : (rows ?? [])
        .filter((row) => row.family === 'IPv4' && !row.internal)
        .map((row) => ({ address: row.address, interfaceName })));
  return [
    ...entries.filter((entry) => !TUNNEL_INTERFACE_PATTERN.test(entry.interfaceName)),
    ...entries.filter((entry) => TUNNEL_INTERFACE_PATTERN.test(entry.interfaceName)),
  ];
}

// `ufw status` needs root, but ufw's on-disk enable flag is world-readable.
// Best-effort: an unreadable or missing file simply means "no note".
export async function isUfwEnabled(
  readFileImpl: (path: string, encoding: 'utf8') => Promise<string> = fs.readFile,
): Promise<boolean> {
  try {
    return /^ENABLED=yes$/m.test(await readFileImpl('/etc/ufw/ufw.conf', 'utf8'));
  } catch {
    return false;
  }
}

// Mirrors incrementTokenVersion() in server/middleware/auth.js without
// importing it (that module derives a JWT secret at import time, which must
// not run inside the installer process before DATABASE_PATH is final).
function bumpTokenVersion(userId: number | bigint): void {
  const stored = appConfigDb.get(`auth_token_version:${userId}`);
  const parsed = Number.parseInt(String(stored ?? '0'), 10);
  const next = (Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0) + 1;
  appConfigDb.set(`auth_token_version:${userId}`, String(next));
  appConfigDb.set('auth_token_version_schema', '1');
}

// Mirrors resolveSessionDays() bounds in server/middleware/auth.js.
function parseSessionDaysOption(value: string | undefined): number {
  const days = Number(value);
  if (!Number.isInteger(days) || days < 1 || days > 365) {
    throw new Error('--session-days must be an integer between 1 and 365');
  }
  return days;
}

async function readPersistedSessionDays(configPath: string): Promise<number | null> {
  try {
    const content = await fs.readFile(configPath, 'utf8');
    const match = /^CHATMUX_SESSION_DAYS=(\d+)$/m.exec(content);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

type ManagedAuthUpdate = {
  mode: 'none' | 'tailscale' | 'password';
  allowUnauthRemote?: boolean;
  /** undefined preserves the persisted session length; a number overwrites it. */
  sessionDays?: number;
};

async function updateManagedAuthMode(configPath: string, update: ManagedAuthUpdate): Promise<void> {
  const databasePath = process.env.DATABASE_PATH as string;
  const serverPort = parsePort(process.env.SERVER_PORT || String(DEFAULT_SERVER_PORT), 'SERVER_PORT');
  const sessionDays = update.sessionDays ?? await readPersistedSessionDays(configPath);
  await fs.writeFile(
    configPath,
    buildManagedEnvironment({
      authMode: update.mode,
      allowUnauthRemote: update.allowUnauthRemote ?? false,
      sessionDays,
      databasePath,
      serverPort,
    }),
    { mode: 0o600 },
  );
}

// Rewrites the HOST bind address inside the installed user unit. Returns false
// when there is no managed unit (or no HOST line) to update.
async function updateManagedUnitHost(home: string, host: string): Promise<boolean> {
  const unitPath = path.join(home, '.config', 'systemd', 'user', 'chatmux.service');
  let unit: string;
  try {
    unit = await fs.readFile(unitPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  if (!/^Environment=HOST=.*$/m.test(unit)) return false;
  const updated = unit.replace(/^Environment=HOST=.*$/m, `Environment=HOST=${host}`);
  if (updated !== unit) await fs.writeFile(unitPath, updated, 'utf8');
  return true;
}

// Reads the bind address the managed unit actually starts the service with.
// Returns null when no managed unit exists or it has no HOST line.
export async function readManagedUnitHost(home: string = os.homedir()): Promise<string | null> {
  try {
    const unit = await fs.readFile(path.join(home, '.config', 'systemd', 'user', 'chatmux.service'), 'utf8');
    return /^Environment=HOST=(.*)$/m.exec(unit)?.[1]?.trim() || null;
  } catch {
    return null;
  }
}

// The QR code makes phone setup one camera scan instead of typing an address.
async function printAccessQr(run: CommandRunner, url: string): Promise<void> {
  try {
    const qr = await run('qrencode', ['-t', 'ANSIUTF8', url]);
    if (qr.stdout.trim()) console.log(`\n${qr.stdout}`);
  } catch {
    console.log('QR: install qrencode to print this address as a terminal QR code');
  }
}

export async function runAccessCli(args: string[], context: Pick<InstallContext, 'home' | 'run' | 'interfaces'> = {}): Promise<void> {
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
      await updateManagedAuthMode(configPath, { mode: 'tailscale' });
      await updateManagedUnitHost(home, '127.0.0.1');
      await run('systemctl', ['--user', 'daemon-reload']);
      const serverPort = Number(process.env.SERVER_PORT || DEFAULT_SERVER_PORT);
      const serve = await configureTailscaleServe(run, serverPort, null);
      appConfigDb.set(MANAGED_SERVE_PORT_KEY, String(serve.httpsPort));
      await run('systemctl', ['--user', 'restart', 'chatmux.service']);
      console.log(`Tailscale access enabled: ${serve.url}`);
      // The install-time LAN address and its QR stop working here: this mode
      // only authenticates loopback-sourced (Serve-proxied) requests.
      console.log('The LAN address printed at install no longer works — scan the code below instead.');
      console.log('Every device needs Tailscale connected and an allowed account.');
      await printAccessQr(run, serve.url);
      return;
    }
    if (command === 'enable' && rest[0] === 'vpn') {
      const host = assertVpnBindHost(rest[1] ?? '', context.interfaces);
      if (!(await updateManagedUnitHost(home, host))) {
        throw new Error('No managed chatmux.service unit was found; run "chatmux install" first, then re-run this command');
      }
      await updateManagedAuthMode(configPath, { mode: 'none', allowUnauthRemote: true });
      await run('systemctl', ['--user', 'daemon-reload']);
      await run('systemctl', ['--user', 'restart', 'chatmux.service']);
      const serverPort = Number(process.env.SERVER_PORT || DEFAULT_SERVER_PORT);
      const url = `http://${host}:${serverPort}`;
      console.log(`VPN access enabled: ${url} (no login — only devices inside the VPN can reach it)`);
      console.log('The LAN address printed at install no longer works — scan the code below instead.');
      await printAccessQr(run, url);
      return;
    }
    if (command === 'enable' && rest[0] === 'password') {
      let address = '0.0.0.0';
      let sessionDays: number | undefined;
      for (let index = 1; index < rest.length; index += 1) {
        const argument = rest[index];
        if (argument === '--session-days') sessionDays = parseSessionDaysOption(rest[++index]);
        else if (argument.startsWith('--session-days=')) sessionDays = parseSessionDaysOption(argument.slice('--session-days='.length));
        else address = argument;
      }
      const host = assertPasswordBindHost(address);
      const serverPort = Number(process.env.SERVER_PORT || DEFAULT_SERVER_PORT);
      // The exposure guard refuses a non-loopback bind while no account
      // exists, so the first run stays on loopback and walks the operator
      // through creating the owner account.
      const hasOwner = userDb.hasUsers();
      const bindHost = hasOwner ? host : '127.0.0.1';
      if (!(await updateManagedUnitHost(home, bindHost))) {
        throw new Error('No managed chatmux.service unit was found; run "chatmux install" first, then re-run this command');
      }
      await updateManagedAuthMode(configPath, { mode: 'password', sessionDays });
      await run('systemctl', ['--user', 'daemon-reload']);
      await run('systemctl', ['--user', 'restart', 'chatmux.service']);
      if (!hasOwner) {
        console.log('Password mode is on, but no account exists yet, so the bind stays on 127.0.0.1 (fail-closed).');
        console.log(`  1) Open http://127.0.0.1:${serverPort} in a browser on this machine and create the owner account`);
        console.log(`  2) Re-run: chatmux access enable password${host === '0.0.0.0' ? '' : ` ${host}`}`);
        return;
      }
      const displayAddresses = host === '0.0.0.0'
        ? listLanAddresses(context.interfaces ?? os.networkInterfaces)
        : [{ address: host, interfaceName: 'requested' }];
      const [primary, ...alternates] = displayAddresses;
      const effectiveDays = await readPersistedSessionDays(configPath) ?? 7;
      console.log('Password access enabled — any browser can sign in, no app required.');
      if (primary) console.log(`  Address: http://${primary.address}:${serverPort}`);
      if (alternates.length > 0) {
        console.log(`  Also:    ${alternates.map((entry) => `http://${entry.address}:${serverPort} (${entry.interfaceName})`).join(' · ')}`);
      }
      console.log(`  Session: stays signed in forever while used at least once every ${effectiveDays} days (idle sessions expire; change with --session-days <n>)`);
      console.log('  Reach:   same Wi-Fi works immediately; for access from anywhere, forward this TCP port on the router');
      console.log('  HTTPS:   put a TLS proxy in front before exposing to the internet — see docs/INSTALL.md');
      if (await isUfwEnabled()) {
        console.log(`  Note:    the ufw firewall is enabled — phones stay blocked until you run: sudo ufw allow ${serverPort}/tcp`);
      }
      if (primary) await printAccessQr(run, `http://${primary.address}:${serverPort}`);
      return;
    }
    if (command === 'password') {
      const owner = userDb.getFirstUser();
      if (!owner) {
        throw new Error('No account exists yet; run "chatmux install" first');
      }
      const provided = rest[0];
      if (provided !== undefined && provided.length < 6) {
        throw new Error('Password must be at least 6 characters');
      }
      const nextPassword = provided ?? generateInitialPassword();
      userDb.updatePasswordHash(owner.id, await bcrypt.hash(nextPassword, PASSWORD_HASH_ROUNDS));
      // Rotating the password must also kick out every session issued under
      // the old one — the token version bump revokes them immediately.
      bumpTokenVersion(owner.id);
      console.log(provided
        ? `Password updated for "${owner.username}".`
        : `Password updated for "${owner.username}": ${nextPassword}`);
      console.log('Every existing session has been signed out.');
      return;
    }
    throw new Error('Usage: chatmux access users | owner [login] | allow <login> | revoke <login> | password [new-password] | enable tailscale [owner] | enable vpn <address> | enable password [address] [--session-days <n>]');
  } finally {
    closeConnection();
  }
}
