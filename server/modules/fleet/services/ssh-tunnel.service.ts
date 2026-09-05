import { dirname, join } from 'node:path';

import { fleetSshTunnelsDb, getDatabasePath, type FleetSshTunnelRecord } from '@/modules/database/index.js';
import { InvalidSshTargetError, parseSshTarget, type SshTarget } from '@/modules/fleet/services/ssh-target.js';
import { realSshTunnelIo, type SshProcess, type SshRunResult, type SshTunnelIo } from '@/modules/fleet/services/ssh-tunnel-io.js';

import { fleetSshErrorDetails, type FleetSshEnrollmentErrorCode, type FleetSshEnrollmentErrorDetails } from '../../../../shared/fleet-ssh.js';

import { SSH_CLI_MISSING_MARKER, SSH_MINT_TOKEN_COMMAND, sshBootstrapCommand, sshBootstrapVersion } from './ssh-bootstrap.js';

export type { SshProcess, SshProcessOptions, SshRunResult, SshTunnelIo } from '@/modules/fleet/services/ssh-tunnel-io.js';
export type SshTunnelRecord = FleetSshTunnelRecord;
export interface SshTunnelStore {
  findByPeerId(peerId: string): SshTunnelRecord | undefined;
  findByTarget(sshTarget: string): SshTunnelRecord | undefined;
  list(): readonly SshTunnelRecord[];
  save(record: SshTunnelRecord): void;
  delete(peerId: string): void;
}
export type SshEnrollmentErrorCode = FleetSshEnrollmentErrorCode;
export type SshEnrollmentErrorDetails = FleetSshEnrollmentErrorDetails;

export class SshEnrollmentError extends Error {
  readonly name = 'SshEnrollmentError';
  constructor(
    readonly code: SshEnrollmentErrorCode,
    message: string,
    readonly cleanupErrors: readonly Error[] = [],
    readonly details: SshEnrollmentErrorDetails = {},
  ) { super(message); }
}

type Scheduled = Readonly<{ cancel(): void }>;
type Scheduler = Readonly<{ schedule(delayMs: number, callback: () => void): Scheduled }>;
type TunnelPaths = Readonly<{ directory: string; privateKey: string; publicKey: string; knownHosts: string }>;
type ManagerDependencies = Readonly<{
  io: SshTunnelIo;
  store: SshTunnelStore;
  paths: TunnelPaths;
  scheduler: Scheduler;
  maxRestartAttempts?: number;
  readinessTimeoutMs?: number;
  healthyResetMs?: number;
  bootstrapVersion?: () => Promise<string | undefined>;
  report?: (code: SshEnrollmentErrorCode, peerId: string) => void;
}>;
type ActiveTunnel = {
  process?: SshProcess;
  readonly record: SshTunnelRecord;
  restarts: number;
  stopping: boolean;
  restartTimer?: Scheduled;
  healthyTimer?: Scheduled;
};
export type PreparedSshTunnel = Readonly<{
  localPort: number;
  token: string;
  complete(peerId: string): void;
  abort(): Promise<void>;
}>;

type Askpass = Readonly<{ directory: string; helper: string; payload: string }>;
type Launch = Readonly<{ process: SshProcess; exited: Promise<SshRunResult> }>;
const REMOTE_FLEET_PORT = 3001;
const TOKEN_LINE = /^Pairing token: ([A-Za-z0-9_-]{43})$/;
const EXEC_TIMEOUT_MS = 15_000;
// Downloading the release archive plus a private Node runtime can take minutes on slow links.
const INSTALL_TIMEOUT_MS = 15 * 60_000;
const CLI_MISSING_LINE = new RegExp(`^${SSH_CLI_MISSING_MARKER} ([A-Za-z0-9_.-]{1,32}) ([A-Za-z0-9_.-]{1,32})\r?\n?$`);
const SUPPORTED_REMOTE_OS = 'Linux';
const SUPPORTED_REMOTE_ARCH = 'x86_64';
const CONTROL_PERSIST_SECONDS = 60;
const KEY_REMOVAL_SENTINEL = 'chatmux-fleet-remove-key-v1';
const LEGACY_KEY_PREFIX = 'restrict,port-forwarding,no-pty ';
const DENY_COMMAND_KEY_PREFIX = 'restrict,port-forwarding,permitopen="127.0.0.1:3001",command="false" ';

type SetupPhases = { masterCreated: boolean; keyInstalled: boolean; restrictedMaster: boolean };

function shellQuote(value: string): string { return `'${value.replaceAll("'", `'"'"'`)}'`; }
function keyRemovalCommand(publicKey: string): string {
  return `tmp=$(mktemp) || exit 1; trap 'rm -f "$tmp"' EXIT; (grep -vF ${shellQuote(publicKey)} "$HOME/.ssh/authorized_keys" > "$tmp" || true) && cat "$tmp" > "$HOME/.ssh/authorized_keys"`;
}
function restrictedKeyPrefix(publicKey: string): string {
  const forced = `case "$SSH_ORIGINAL_COMMAND" in ${KEY_REMOVAL_SENTINEL}) ;; *) exit 126 ;; esac; ${keyRemovalCommand(publicKey)}`;
  const encoded = forced.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
  return `command="${encoded}",restrict,port-forwarding,permitopen="127.0.0.1:3001" `;
}

const FALLBACK_MESSAGES = {
  REMOTE_CLI_FAILED: 'Remote ChatMux CLI failed',
  REMOTE_INSTALL_FAILED: 'ChatMux could not be installed on the remote PC',
  TUNNEL_FAILED: 'SSH tunnel failed',
} as const;

function classify(result: SshRunResult, fallback: keyof typeof FALLBACK_MESSAGES): SshEnrollmentError {
  const diagnostic = result.stderr.toLowerCase();
  if (diagnostic.includes('permission denied') || diagnostic.includes('authentication failed')) return new SshEnrollmentError('SSH_AUTH_FAILED', 'SSH authentication failed');
  if (diagnostic.includes('connection timed out') || diagnostic.includes('no route to host') || diagnostic.includes('connection refused') || result.code === null) return new SshEnrollmentError('SSH_UNREACHABLE', 'SSH target is unreachable');
  if (diagnostic.includes('host key verification failed') || diagnostic.includes('remote host identification has changed')) return new SshEnrollmentError('HOSTKEY_REJECTED', 'SSH host key was rejected');
  return new SshEnrollmentError(fallback, FALLBACK_MESSAGES[fallback]);
}

/** Recognizes the marker line the mint command prints when no ChatMux CLI exists on the remote. */
function missingCli(result: SshRunResult): SshEnrollmentError | undefined {
  if (result.code !== 127 || result.stdout.trim() !== '') return undefined;
  const match = CLI_MISSING_LINE.exec(result.stderr);
  if (match?.[1] === undefined || match[2] === undefined) return undefined;
  const details = fleetSshErrorDetails({ os: match[1], arch: match[2] });
  if (details.os !== SUPPORTED_REMOTE_OS || details.arch !== SUPPORTED_REMOTE_ARCH) {
    return new SshEnrollmentError('REMOTE_PLATFORM_UNSUPPORTED', `ChatMux peers require ${SUPPORTED_REMOTE_OS} ${SUPPORTED_REMOTE_ARCH}; the remote PC reports ${details.os} ${details.arch}`, [], details);
  }
  return new SshEnrollmentError('REMOTE_CLI_MISSING', 'ChatMux is not installed on the remote PC', [], details);
}

function parseToken(stdout: string): string {
  const lines = stdout.split(/\r?\n/);
  const match = TOKEN_LINE.exec(lines[0] ?? '');
  if (match?.[1] === undefined || lines.slice(1).some((line) => line.startsWith('Pairing token:'))) {
    throw new SshEnrollmentError('TOKEN_PARSE_FAILED', 'Remote ChatMux CLI returned an invalid pairing token');
  }
  return match[1];
}

function errorValue(value: unknown): Error { return value instanceof Error ? value : new Error('Unknown SSH cleanup failure'); }

export class SshTunnelManager {
  private readonly active = new Map<string, ActiveTunnel>();
  private readonly reservedTargets = new Set<string>();
  private readonly reservedPorts = new Set<number>();
  private keyInitialization: Promise<void> | undefined;
  constructor(private readonly dependencies: ManagerDependencies) {}

  async prepare(input: Readonly<{ sshTarget: string; password?: string; installCli?: boolean }>): Promise<PreparedSshTunnel> {
    let target: SshTarget;
    try { target = parseSshTarget(input.sshTarget); }
    catch (error) {
      if (error instanceof InvalidSshTargetError) throw new SshEnrollmentError('INVALID_SSH_TARGET', error.message);
      throw error;
    }
    const existing = this.dependencies.store.findByTarget(target.sshTarget);
    if ((input.password === undefined || input.password.length === 0) && existing === undefined) {
      throw new SshEnrollmentError('SSH_PASSWORD_REQUIRED', 'SSH password is required until the tunnel key is installed');
    }
    if (this.reservedTargets.has(target.sshTarget)) throw new SshEnrollmentError('TUNNEL_FAILED', 'SSH target enrollment is already in progress');
    this.reservedTargets.add(target.sshTarget);
    let localPort: number;
    try {
      await this.ensureKey();
      if (existing !== undefined && this.reservedPorts.has(existing.localPort)) throw new SshEnrollmentError('TUNNEL_FAILED', 'SSH tunnel port is already reserved');
      localPort = existing?.localPort ?? await this.allocateUniquePort();
      this.reservedPorts.add(localPort);
    } catch (error) {
      this.reservedTargets.delete(target.sshTarget);
      throw error;
    }
    const controlPath = join(this.dependencies.paths.directory, `control-${localPort}`);
    const password = input.password === undefined || input.password.length === 0 ? undefined : input.password;
    let askpass: Askpass | undefined;
    let launch: Launch | undefined;
    const phases: SetupPhases = { masterCreated: false, keyInstalled: false, restrictedMaster: false };
    let completed = false;
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true; this.reservedTargets.delete(target.sshTarget); this.reservedPorts.delete(localPort);
    };
    try {
      askpass = password === undefined ? undefined : await this.createAskpass(password);
      await this.openMaster(target, controlPath, askpass?.helper);
      phases.masterCreated = true;
      if (askpass !== undefined) { await this.dependencies.io.rm(askpass.directory); askpass = undefined; }
      phases.keyInstalled = true;
      await this.installKey(target, controlPath);
      const token = await this.mintToken(target, controlPath, input.installCli === true);
      await this.terminateMaster(target, controlPath); phases.masterCreated = false;
      try {
        await this.dependencies.io.waitUntilUnavailable(localPort, controlPath, this.dependencies.readinessTimeoutMs ?? 5_000);
      } catch {
        throw new SshEnrollmentError('TUNNEL_FAILED', 'the local tunnel port stayed occupied after the control master exited');
      }
      launch = this.spawnTunnel(target, localPort, controlPath, true);
      phases.masterCreated = true; phases.restrictedMaster = true;
      await this.awaitReady(launch, target, localPort, controlPath);
      const tunnel = launch.process;
      return {
        localPort,
        token,
        complete: (peerId) => {
          if (completed) return;
          const record: SshTunnelRecord = { peerId, sshTarget: target.sshTarget, localPort, ...(target.sshPort === undefined ? {} : { sshPort: target.sshPort }) };
          this.dependencies.store.save(record);
          completed = true; release();
          const managed: ActiveTunnel = { process: tunnel, record, restarts: 0, stopping: false };
          this.active.set(peerId, managed); this.watch(peerId, managed); this.scheduleHealthyReset(peerId, managed);
        },
        abort: async () => {
          if (completed) return;
          const errors = await this.unwind(target, controlPath, localPort, phases, launch?.process, release);
          if (errors.length > 0) throw new SshEnrollmentError('TUNNEL_FAILED', 'SSH enrollment cleanup was incomplete', errors);
        },
      };
    } catch (error) {
      const errors = await this.unwind(target, controlPath, localPort, phases, launch?.process, release, askpass?.directory);
      if (errors.length > 0) {
        const original = error instanceof SshEnrollmentError ? error : new SshEnrollmentError('TUNNEL_FAILED', 'SSH tunnel setup failed');
        throw new SshEnrollmentError(original.code, `${original.message}; cleanup was incomplete`, [...original.cleanupErrors, ...errors], original.details);
      }
      throw error;
    }
  }

  async remove(peerId: string): Promise<void> {
    const record = this.dependencies.store.findByPeerId(peerId);
    const managed = this.active.get(peerId);
    if (managed !== undefined) {
      managed.stopping = true; managed.restartTimer?.cancel(); managed.healthyTimer?.cancel(); managed.process?.stop('SIGTERM'); this.active.delete(peerId);
    }
    if (record === undefined) return;
    this.dependencies.store.delete(peerId);
    const target = parseSshTarget(record.sshTarget);
    const errors = await this.cleanupSteps([
      () => this.removeInstalledKey(target, this.recordControlPath(record)),
      () => this.reclaimMaster(target, this.recordControlPath(record), record.localPort),
    ]);
    if (errors.length > 0) {
      this.dependencies.report?.('TUNNEL_FAILED', peerId);
      throw new SshEnrollmentError('TUNNEL_FAILED', 'SSH tunnel cleanup was incomplete', errors);
    }
  }

  async restore(): Promise<void> {
    try { await this.ensureKey(); }
    catch (error) { this.dependencies.report?.('TUNNEL_FAILED', 'key'); return; }
    for (const record of this.dependencies.store.list()) {
      if (this.active.has(record.peerId)) continue;
      const target = parseSshTarget(record.sshTarget); const controlPath = this.recordControlPath(record);
      let launch: Launch | undefined;
      const managed: ActiveTunnel = { record, restarts: 0, stopping: false };
      this.active.set(record.peerId, managed);
      try {
        await this.reclaimMaster(target, controlPath, record.localPort);
        launch = this.spawnTunnel(target, record.localPort, controlPath, true); managed.process = launch.process;
        await this.awaitReady(launch, target, record.localPort, controlPath);
        this.watch(record.peerId, managed); this.scheduleHealthyReset(record.peerId, managed);
      } catch (error) {
        launch?.process.stop('SIGTERM');
        await this.reclaimMaster(target, controlPath, record.localPort).catch(() => undefined);
        this.dependencies.report?.('TUNNEL_FAILED', record.peerId); this.scheduleRestart(record.peerId, managed);
      }
    }
  }

  stop(): void {
    for (const managed of this.active.values()) { managed.stopping = true; managed.restartTimer?.cancel(); managed.healthyTimer?.cancel(); managed.process?.stop('SIGTERM'); }
    this.active.clear();
  }

  private recordControlPath(record: SshTunnelRecord): string { return join(this.dependencies.paths.directory, `control-${record.localPort}`); }
  private async allocateUniquePort(): Promise<number> {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const port = await this.dependencies.io.allocatePort();
      if (!this.reservedPorts.has(port) && !this.dependencies.store.list().some((record) => record.localPort === port)) {
        this.reservedPorts.add(port);
        return port;
      }
    }
    throw new SshEnrollmentError('TUNNEL_FAILED', 'No unique SSH tunnel port is available');
  }
  private async ensureKey(): Promise<void> {
    if (this.keyInitialization !== undefined) return this.keyInitialization;
    const pending = this.initializeKey();
    this.keyInitialization = pending;
    try { await pending; } finally { if (this.keyInitialization === pending) this.keyInitialization = undefined; }
  }
  private async initializeKey(): Promise<void> {
    await this.dependencies.io.mkdir(this.dependencies.paths.directory, 0o700);
    if (await this.dependencies.io.fileExists(this.dependencies.paths.privateKey)) return;
    const result = await this.dependencies.io.run('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', 'chatmux-fleet-tunnel', '-f', this.dependencies.paths.privateKey], { timeoutMs: EXEC_TIMEOUT_MS });
    if (result.code !== 0) throw classify(result, 'TUNNEL_FAILED');
  }
  private async createAskpass(password: string): Promise<Askpass> {
    const directory = await this.dependencies.io.mkdtemp(join(this.dependencies.paths.directory, 'askpass-'));
    const payload = join(directory, 'payload'); const helper = join(directory, 'askpass');
    try {
      await this.dependencies.io.writeFile(payload, `${password}\n`, 0o600);
      await this.dependencies.io.writeFile(helper, `#!/bin/sh\npayload=${shellQuote(payload)}\ntrap 'rm -f -- "$payload" "$0"' EXIT\ncat -- "$payload"\n`, 0o700);
      return { directory, helper, payload };
    } catch (error) {
      try { await this.dependencies.io.rm(directory); }
      catch (cleanupError) { throw new AggregateError([errorValue(error), errorValue(cleanupError)], 'SSH askpass creation and cleanup failed'); }
      throw error;
    }
  }
  private commonArgs(target: SshTarget): string[] {
    return ['-o', 'StrictHostKeyChecking=accept-new', '-o', `UserKnownHostsFile=${this.dependencies.paths.knownHosts}`, '-i', this.dependencies.paths.privateKey, ...(target.sshPort === undefined ? [] : ['-p', String(target.sshPort)])];
  }
  private keyAuthenticationArgs(target: SshTarget): string[] { return ['-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', ...this.commonArgs(target)]; }
  private commandArgs(target: SshTarget): string[] { return ['-o', 'ClearAllForwardings=yes', ...this.keyAuthenticationArgs(target)]; }
  private controlArgs(target: SshTarget, controlPath: string): string[] { return [...this.commandArgs(target), '-o', `ControlPath=${controlPath}`]; }
  private async openMaster(target: SshTarget, controlPath: string, askpass?: string): Promise<void> {
    const env = askpass === undefined ? undefined : { ...process.env, SSH_ASKPASS: askpass, SSH_ASKPASS_REQUIRE: 'force', DISPLAY: ':0' };
    const args = ['-N', '-f', '-o', 'ClearAllForwardings=yes', '-o', 'ControlMaster=yes', '-o', `ControlPersist=${CONTROL_PERSIST_SECONDS}`, '-o', `ControlPath=${controlPath}`, ...this.commonArgs(target), target.destination];
    const result = await this.dependencies.io.run('ssh', args, { ...(env === undefined ? {} : { env }), timeoutMs: EXEC_TIMEOUT_MS });
    if (result.code !== 0) throw classify(result, 'TUNNEL_FAILED');
  }
  private async installKey(target: SshTarget, controlPath: string): Promise<void> {
    const publicKey = (await this.dependencies.io.readFile(this.dependencies.paths.publicKey)).trim();
    if (!/^ssh-ed25519 [A-Za-z0-9+/]+={0,3}(?: [A-Za-z0-9._-]+)?$/.test(publicKey)) throw new SshEnrollmentError('TUNNEL_FAILED', 'Tunnel public key is invalid');
    const entry = `${restrictedKeyPrefix(publicKey)}${publicKey}`;
    const legacy = `${LEGACY_KEY_PREFIX}${publicKey}`; const denied = `${DENY_COMMAND_KEY_PREFIX}${publicKey}`;
    const command = `mkdir -p ~/.ssh && chmod 700 ~/.ssh && touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && tmp=$(mktemp) && (grep -vxF ${shellQuote(publicKey)} ~/.ssh/authorized_keys | grep -vxF ${shellQuote(legacy)} | grep -vxF ${shellQuote(denied)} | grep -vF ${shellQuote(publicKey)} > "$tmp" || true) && printf '%s\\n' ${shellQuote(entry)} >> "$tmp" && cat "$tmp" > ~/.ssh/authorized_keys && rm -f "$tmp"`;
    const result = await this.dependencies.io.run('ssh', [...this.controlArgs(target, controlPath), target.destination, command], { env: this.cleanEnv(), timeoutMs: EXEC_TIMEOUT_MS });
    if (result.code !== 0) throw classify(result, 'TUNNEL_FAILED');
  }
  private async mintToken(target: SshTarget, controlPath: string, installMissingCli: boolean): Promise<string> {
    const first = await this.runRemote(target, controlPath, SSH_MINT_TOKEN_COMMAND, EXEC_TIMEOUT_MS);
    const missing = missingCli(first);
    if (missing === undefined) return this.tokenFrom(first);
    if (missing.code !== 'REMOTE_CLI_MISSING' || !installMissingCli) throw missing;
    // The control master was authenticated by the owner's password, so the installer runs with the
    // same authority as an interactive login; the restricted hub key never gains command access.
    const command = sshBootstrapCommand(await (this.dependencies.bootstrapVersion ?? sshBootstrapVersion)());
    if (command === undefined) throw new SshEnrollmentError('REMOTE_INSTALL_FAILED', 'The hub does not have a stable release version for remote installation');
    const installed = await this.runRemote(target, controlPath, command, INSTALL_TIMEOUT_MS);
    if (installed.code !== 0) throw new SshEnrollmentError('REMOTE_INSTALL_FAILED', 'Remote installation did not complete; inspect the remote PC before retrying');
    return this.tokenFrom(await this.runRemote(target, controlPath, SSH_MINT_TOKEN_COMMAND, EXEC_TIMEOUT_MS));
  }
  private tokenFrom(result: SshRunResult): string {
    if (result.code !== 0) {
      throw missingCli(result) ?? classify(result, 'REMOTE_CLI_FAILED');
    }
    return parseToken(result.stdout);
  }
  private runRemote(target: SshTarget, controlPath: string, command: string, timeoutMs: number): Promise<SshRunResult> {
    return this.dependencies.io.run('ssh', [...this.controlArgs(target, controlPath), target.destination, command], { env: this.cleanEnv(), timeoutMs });
  }
  private spawnTunnel(target: SshTarget, localPort: number, controlPath: string, createMaster: boolean): Launch {
    const args = ['-N', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3', ...(createMaster ? ['-o', 'ControlMaster=yes', '-o', `ControlPersist=${CONTROL_PERSIST_SECONDS}`] : []), ...this.keyAuthenticationArgs(target), '-o', `ControlPath=${controlPath}`, '-L', `127.0.0.1:${localPort}:127.0.0.1:${REMOTE_FLEET_PORT}`, target.destination];
    const process = this.dependencies.io.spawn('ssh', args, { env: this.cleanEnv() });
    const exited = new Promise<SshRunResult>((resolve) => process.once('exit', (code) => resolve({ code, stdout: '', stderr: '' })));
    return { process, exited };
  }
  private async awaitReady(launch: Launch, target: SshTarget, localPort: number, controlPath: string): Promise<void> {
    const ready = this.dependencies.io.waitUntilReady(localPort, this.dependencies.readinessTimeoutMs ?? 5_000).then(async () => {
      const checked = await this.dependencies.io.run('ssh', [...this.controlArgs(target, controlPath), '-O', 'check', target.destination], { env: this.cleanEnv(), timeoutMs: EXEC_TIMEOUT_MS });
      if (checked.code !== 0) throw classify(checked, 'TUNNEL_FAILED');
      return 'ready' as const;
    });
    const exited = launch.exited.then((result) => ({ result }));
    const outcome = await Promise.race([ready, exited]);
    if (outcome !== 'ready') throw classify(outcome.result, 'TUNNEL_FAILED');
  }
  private cleanEnv(): NodeJS.ProcessEnv {
    const { SSH_ASKPASS: _askpass, SSH_ASKPASS_REQUIRE: _require, DISPLAY: _display, ...env } = process.env;
    return env;
  }
  private async removeInstalledKey(target: SshTarget, controlPath: string, unrestrictedMaster = false): Promise<void> {
    const publicKey = (await this.dependencies.io.readFile(this.dependencies.paths.publicKey)).trim();
    const command = unrestrictedMaster ? keyRemovalCommand(publicKey) : KEY_REMOVAL_SENTINEL;
    const result = await this.dependencies.io.run('ssh', [...this.controlArgs(target, controlPath), target.destination, command], { env: this.cleanEnv(), timeoutMs: EXEC_TIMEOUT_MS });
    if (result.code !== 0) throw classify(result, 'TUNNEL_FAILED');
  }
  private async terminateMaster(target: SshTarget, controlPath: string): Promise<void> {
    const checked = await this.dependencies.io.run('ssh', [...this.controlArgs(target, controlPath), '-O', 'check', target.destination], { env: this.cleanEnv(), timeoutMs: EXEC_TIMEOUT_MS });
    if (checked.code === 0) {
      const exited = await this.dependencies.io.run('ssh', [...this.controlArgs(target, controlPath), '-O', 'exit', target.destination], { env: this.cleanEnv(), timeoutMs: EXEC_TIMEOUT_MS });
      if (exited.code !== 0) throw classify(exited, 'TUNNEL_FAILED');
    } else if (await this.dependencies.io.fileExists(controlPath)) {
      await this.dependencies.io.rm(controlPath);
    }
  }
  private async reclaimMaster(target: SshTarget, controlPath: string, localPort: number): Promise<void> {
    const ownedControlPath = join(this.dependencies.paths.directory, `control-${localPort}`);
    if (controlPath !== ownedControlPath) throw new SshEnrollmentError('TUNNEL_FAILED', 'SSH control path is outside the managed directory');
    await this.terminateMaster(target, controlPath);
    await this.dependencies.io.waitUntilUnavailable(localPort, controlPath, this.dependencies.readinessTimeoutMs ?? 5_000);
  }
  private async cleanupSteps(steps: ReadonlyArray<() => Promise<void> | void>): Promise<Error[]> {
    const errors: Error[] = [];
    for (const step of steps) { try { await step(); } catch (error) { errors.push(errorValue(error)); } }
    return errors;
  }
  private async unwind(target: SshTarget, controlPath: string, localPort: number, phases: SetupPhases, process: SshProcess | undefined, release: () => void, askpassDirectory?: string): Promise<Error[]> {
    return this.cleanupSteps([
      ...(process === undefined ? [] : [() => { process.stop('SIGTERM'); }]),
      ...(phases.keyInstalled ? [() => this.removeInstalledKey(target, controlPath, phases.masterCreated && !phases.restrictedMaster)] : []),
      ...(phases.masterCreated ? [() => this.reclaimMaster(target, controlPath, localPort)] : []),
      () => { release(); },
      ...(askpassDirectory === undefined ? [] : [() => this.dependencies.io.rm(askpassDirectory)]),
    ]);
  }
  private watch(peerId: string, managed: ActiveTunnel): void {
    managed.process?.once('exit', () => {
      if (!managed.stopping && this.active.get(peerId) === managed) this.scheduleRestart(peerId, managed);
    });
  }
  private scheduleHealthyReset(peerId: string, managed: ActiveTunnel): void {
    managed.healthyTimer?.cancel();
    managed.healthyTimer = this.dependencies.scheduler.schedule(this.dependencies.healthyResetMs ?? 30_000, () => {
      if (!managed.stopping && this.active.get(peerId) === managed) managed.restarts = 0;
    });
  }
  private scheduleRestart(peerId: string, managed: ActiveTunnel): void {
    managed.healthyTimer?.cancel();
    const max = this.dependencies.maxRestartAttempts ?? 5;
    if (managed.restarts >= max) { managed.process?.stop('SIGTERM'); this.active.delete(peerId); this.dependencies.report?.('TUNNEL_FAILED', peerId); return; }
    const delay = Math.min(30_000, 1_000 * (2 ** managed.restarts)); managed.restarts += 1;
    managed.restartTimer = this.dependencies.scheduler.schedule(delay, () => {
      if (managed.stopping || this.active.get(peerId) !== managed) return;
      void (async () => {
        const target = parseSshTarget(managed.record.sshTarget); const controlPath = this.recordControlPath(managed.record);
        managed.process?.stop('SIGTERM');
        let launch: Launch | undefined;
        try {
          await this.reclaimMaster(target, controlPath, managed.record.localPort);
          if (managed.stopping || this.active.get(peerId) !== managed) return;
          launch = this.spawnTunnel(target, managed.record.localPort, controlPath, true); managed.process = launch.process;
          await this.awaitReady(launch, target, managed.record.localPort, controlPath);
          if (managed.stopping || this.active.get(peerId) !== managed) { launch.process.stop('SIGTERM'); return; }
          this.watch(peerId, managed); this.scheduleHealthyReset(peerId, managed);
        } catch (error) {
          launch?.process.stop('SIGTERM');
          await this.reclaimMaster(target, controlPath, managed.record.localPort).catch(() => undefined);
          if (!managed.stopping && this.active.get(peerId) === managed) this.scheduleRestart(peerId, managed);
        }
      })().catch(() => { if (!managed.stopping && this.active.get(peerId) === managed) this.scheduleRestart(peerId, managed); });
    });
  }
}

const directory = join(dirname(getDatabasePath()), 'fleet-ssh');
export const fleetSshTunnelManager = new SshTunnelManager({
  io: realSshTunnelIo,
  store: fleetSshTunnelsDb,
  paths: { directory, privateKey: join(directory, 'id_ed25519'), publicKey: join(directory, 'id_ed25519.pub'), knownHosts: join(directory, 'known_hosts') },
  scheduler: { schedule: (delayMs, callback) => { const timer = setTimeout(callback, delayMs); timer.unref(); return { cancel: () => clearTimeout(timer) }; } },
  report: (code, peerId) => console.error(`Fleet SSH tunnel ${peerId} entered retryable failure state: ${code}`),
});
