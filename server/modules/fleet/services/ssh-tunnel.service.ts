import { dirname, join } from 'node:path';

import { fleetSshTunnelsDb, getDatabasePath, type FleetSshTunnelRecord } from '@/modules/database/index.js';
import { InvalidSshTargetError, parseSshTarget, type SshTarget } from '@/modules/fleet/services/ssh-target.js';
import { realSshTunnelIo, type SshProcess, type SshRunResult, type SshTunnelIo } from '@/modules/fleet/services/ssh-tunnel-io.js';

export type { SshProcess, SshProcessOptions, SshRunResult, SshTunnelIo } from '@/modules/fleet/services/ssh-tunnel-io.js';
export type SshTunnelRecord = FleetSshTunnelRecord;
export interface SshTunnelStore {
  findByPeerId(peerId: string): SshTunnelRecord | undefined;
  findByTarget(sshTarget: string): SshTunnelRecord | undefined;
  list(): readonly SshTunnelRecord[];
  save(record: SshTunnelRecord): void;
  delete(peerId: string): void;
}
export type SshEnrollmentErrorCode =
  | 'INVALID_SSH_TARGET' | 'MALFORMED_REQUEST' | 'SSH_PASSWORD_REQUIRED' | 'SSH_AUTH_FAILED' | 'SSH_UNREACHABLE'
  | 'HOSTKEY_REJECTED' | 'REMOTE_CLI_FAILED' | 'TOKEN_PARSE_FAILED' | 'ENROLL_FAILED'
  | 'PEER_LIMIT_REACHED' | 'TUNNEL_FAILED';

export class SshEnrollmentError extends Error {
  readonly name = 'SshEnrollmentError';
  constructor(readonly code: SshEnrollmentErrorCode, message: string) { super(message); }
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
  report?: (code: SshEnrollmentErrorCode, peerId: string) => void;
}>;
type ActiveTunnel = {
  process: SshProcess;
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
const CONTROL_PERSIST_SECONDS = 60;
const KEY_PREFIX = 'restrict,port-forwarding,no-pty ';

function shellQuote(value: string): string { return `'${value.replaceAll("'", `'"'"'`)}'`; }

function classify(result: SshRunResult, fallback: 'REMOTE_CLI_FAILED' | 'TUNNEL_FAILED'): SshEnrollmentError {
  const diagnostic = result.stderr.toLowerCase();
  if (diagnostic.includes('permission denied') || diagnostic.includes('authentication failed')) return new SshEnrollmentError('SSH_AUTH_FAILED', 'SSH authentication failed');
  if (diagnostic.includes('connection timed out') || diagnostic.includes('no route to host') || diagnostic.includes('connection refused') || result.code === null) return new SshEnrollmentError('SSH_UNREACHABLE', 'SSH target is unreachable');
  if (diagnostic.includes('host key verification failed') || diagnostic.includes('remote host identification has changed')) return new SshEnrollmentError('HOSTKEY_REJECTED', 'SSH host key was rejected');
  return new SshEnrollmentError(fallback, fallback === 'REMOTE_CLI_FAILED' ? 'Remote ChatMux CLI failed' : 'SSH tunnel failed');
}

function parseToken(stdout: string): string {
  const lines = stdout.split(/\r?\n/);
  const match = TOKEN_LINE.exec(lines[0] ?? '');
  if (match?.[1] === undefined || lines.slice(1).some((line) => line.startsWith('Pairing token:'))) {
    throw new SshEnrollmentError('TOKEN_PARSE_FAILED', 'Remote ChatMux CLI returned an invalid pairing token');
  }
  return match[1];
}

export class SshTunnelManager {
  private readonly active = new Map<string, ActiveTunnel>();
  private readonly reservedTargets = new Set<string>();
  private readonly reservedPorts = new Set<number>();
  constructor(private readonly dependencies: ManagerDependencies) {}

  async prepare(input: Readonly<{ sshTarget: string; password?: string }>): Promise<PreparedSshTunnel> {
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
    await this.ensureKey();
    const localPort = existing?.localPort ?? await this.allocateUniquePort();
    const controlPath = existing?.controlPath ?? join(this.dependencies.paths.directory, `control-${localPort}`);
    this.reservedTargets.add(target.sshTarget); this.reservedPorts.add(localPort);
    const password = input.password === undefined || input.password.length === 0 ? undefined : input.password;
    let askpass: Askpass | undefined;
    let launch: Launch | undefined;
    let completed = false;
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true; this.reservedTargets.delete(target.sshTarget); this.reservedPorts.delete(localPort);
    };
    try {
      askpass = password === undefined ? undefined : await this.createAskpass(password);
      const token = await this.installKeyAndMintToken(target, controlPath, askpass?.helper);
      launch = this.spawnTunnel(target, localPort, controlPath, false);
      await this.awaitReady(launch, localPort);
      const tunnel = launch.process;
      return {
        localPort,
        token,
        complete: (peerId) => {
          if (completed) return;
          const record: SshTunnelRecord = { peerId, sshTarget: target.sshTarget, localPort, controlPath, ...(target.sshPort === undefined ? {} : { sshPort: target.sshPort }) };
          this.dependencies.store.save(record);
          completed = true; release();
          const managed: ActiveTunnel = { process: tunnel, record, restarts: 0, stopping: false };
          this.active.set(peerId, managed); this.watch(peerId, managed); this.scheduleHealthyReset(peerId, managed);
        },
        abort: async () => {
          if (completed) return;
          launch?.process.stop('SIGTERM');
          await this.removeInstalledKey(target, controlPath);
          await this.exitMaster(target, controlPath);
          release();
        },
      };
    } catch (error) {
      launch?.process.stop('SIGTERM');
      await this.removeInstalledKey(target, controlPath).catch(() => undefined);
      await this.exitMaster(target, controlPath).catch(() => undefined);
      release();
      throw error;
    } finally {
      if (askpass !== undefined) await this.dependencies.io.rm(askpass.directory);
    }
  }

  async remove(peerId: string): Promise<void> {
    const record = this.dependencies.store.findByPeerId(peerId);
    const managed = this.active.get(peerId);
    if (managed !== undefined) {
      managed.stopping = true; managed.restartTimer?.cancel(); managed.healthyTimer?.cancel(); managed.process.stop('SIGTERM'); this.active.delete(peerId);
    }
    if (record === undefined) return;
    this.dependencies.store.delete(peerId);
    const target = parseSshTarget(record.sshTarget);
    const controlPath = this.recordControlPath(record);
    await this.removeInstalledKey(target, controlPath);
    await this.exitMaster(target, controlPath);
  }

  async restore(): Promise<void> {
    try { await this.ensureKey(); }
    catch (error) { this.dependencies.report?.('TUNNEL_FAILED', 'key'); return; }
    for (const record of this.dependencies.store.list()) {
      if (this.active.has(record.peerId)) continue;
      try {
        const target = parseSshTarget(record.sshTarget);
        const controlPath = this.recordControlPath(record);
        const checked = await this.dependencies.io.run('ssh', [...this.controlArgs(target, controlPath), '-O', 'check', target.destination], { timeoutMs: EXEC_TIMEOUT_MS });
        const launch = this.spawnTunnel(target, record.localPort, controlPath, checked.code !== 0);
        const managed: ActiveTunnel = { process: launch.process, record, restarts: 0, stopping: false };
        this.active.set(record.peerId, managed); this.watch(record.peerId, managed);
        await this.awaitReady(launch, record.localPort); this.scheduleHealthyReset(record.peerId, managed);
      } catch (error) {
        this.active.delete(record.peerId); this.dependencies.report?.('TUNNEL_FAILED', record.peerId);
      }
    }
  }

  stop(): void {
    for (const managed of this.active.values()) { managed.stopping = true; managed.restartTimer?.cancel(); managed.healthyTimer?.cancel(); managed.process.stop('SIGTERM'); }
    this.active.clear();
  }

  private recordControlPath(record: SshTunnelRecord): string {
    return record.controlPath ?? join(this.dependencies.paths.directory, `control-${record.localPort}`);
  }
  private async allocateUniquePort(): Promise<number> {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const port = await this.dependencies.io.allocatePort();
      if (!this.reservedPorts.has(port) && !this.dependencies.store.list().some((record) => record.localPort === port)) return port;
    }
    throw new SshEnrollmentError('TUNNEL_FAILED', 'No unique SSH tunnel port is available');
  }
  private async ensureKey(): Promise<void> {
    await this.dependencies.io.mkdir(this.dependencies.paths.directory, 0o700);
    if (await this.dependencies.io.fileExists(this.dependencies.paths.privateKey)) return;
    const result = await this.dependencies.io.run('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', 'chatmux-fleet-tunnel', '-f', this.dependencies.paths.privateKey], { timeoutMs: EXEC_TIMEOUT_MS });
    if (result.code !== 0) throw classify(result, 'TUNNEL_FAILED');
  }
  private async createAskpass(password: string): Promise<Askpass> {
    const directory = await this.dependencies.io.mkdtemp(join(this.dependencies.paths.directory, 'askpass-'));
    const payload = join(directory, 'payload'); const helper = join(directory, 'askpass');
    await this.dependencies.io.writeFile(payload, `${password}\n`, 0o600);
    await this.dependencies.io.writeFile(helper, `#!/bin/sh\npayload=${shellQuote(payload)}\ntrap 'rm -f -- "$payload" "$0"' EXIT\ncat -- "$payload"\n`, 0o700);
    return { directory, helper, payload };
  }
  private commonArgs(target: SshTarget): string[] {
    return ['-o', 'StrictHostKeyChecking=accept-new', '-o', `UserKnownHostsFile=${this.dependencies.paths.knownHosts}`, '-i', this.dependencies.paths.privateKey, ...(target.sshPort === undefined ? [] : ['-p', String(target.sshPort)])];
  }
  private keyOnlyArgs(target: SshTarget): string[] {
    return ['-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'ClearAllForwardings=yes', ...this.commonArgs(target)];
  }
  private controlArgs(target: SshTarget, controlPath: string): string[] { return [...this.keyOnlyArgs(target), '-o', `ControlPath=${controlPath}`]; }
  private async installKeyAndMintToken(target: SshTarget, controlPath: string, askpass?: string): Promise<string> {
    const publicKey = (await this.dependencies.io.readFile(this.dependencies.paths.publicKey)).trim();
    if (!/^ssh-ed25519 [A-Za-z0-9+/]+={0,3}(?: [A-Za-z0-9._-]+)?$/.test(publicKey)) throw new SshEnrollmentError('TUNNEL_FAILED', 'Tunnel public key is invalid');
    const entry = `${KEY_PREFIX}${publicKey}`;
    const command = `mkdir -p ~/.ssh && chmod 700 ~/.ssh && touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && (grep -qxF ${shellQuote(entry)} ~/.ssh/authorized_keys || printf '%s\\n' ${shellQuote(entry)} >> ~/.ssh/authorized_keys) && if command -v chatmux >/dev/null 2>&1; then chatmux fleet token; else "$HOME/.chatmux/current/dist-server/server/cli.js" fleet token; fi`;
    const env = askpass === undefined ? undefined : { ...process.env, SSH_ASKPASS: askpass, SSH_ASKPASS_REQUIRE: 'force', DISPLAY: ':0' };
    const args = ['-o', 'ControlMaster=yes', '-o', `ControlPersist=${CONTROL_PERSIST_SECONDS}`, '-o', `ControlPath=${controlPath}`, ...this.commonArgs(target), target.destination, command];
    const result = await this.dependencies.io.run('ssh', args, { ...(env === undefined ? {} : { env }), timeoutMs: EXEC_TIMEOUT_MS });
    if (result.code !== 0) throw classify(result, result.code === 127 || result.stderr.toLowerCase().includes('command not found') ? 'REMOTE_CLI_FAILED' : 'TUNNEL_FAILED');
    return parseToken(result.stdout);
  }
  private spawnTunnel(target: SshTarget, localPort: number, controlPath: string, createMaster: boolean): Launch {
    const args = ['-N', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3', ...(createMaster ? ['-o', 'ControlMaster=yes', '-o', `ControlPersist=${CONTROL_PERSIST_SECONDS}`] : []), ...this.controlArgs(target, controlPath), '-L', `127.0.0.1:${localPort}:127.0.0.1:${REMOTE_FLEET_PORT}`, target.destination];
    const process = this.dependencies.io.spawn('ssh', args, { env: this.cleanEnv() });
    const exited = new Promise<SshRunResult>((resolve) => process.once('exit', (code) => resolve({ code, stdout: '', stderr: '' })));
    return { process, exited };
  }
  private async awaitReady(launch: Launch, localPort: number): Promise<void> {
    const ready = this.dependencies.io.waitUntilReady(localPort, this.dependencies.readinessTimeoutMs ?? 5_000).then(() => 'ready' as const);
    const exited = launch.exited.then((result) => ({ result }));
    const outcome = await Promise.race([ready, exited]);
    if (outcome !== 'ready') throw classify(outcome.result, 'TUNNEL_FAILED');
  }
  private cleanEnv(): NodeJS.ProcessEnv {
    const { SSH_ASKPASS: _askpass, SSH_ASKPASS_REQUIRE: _require, DISPLAY: _display, ...env } = process.env;
    return env;
  }
  private async removeInstalledKey(target: SshTarget, controlPath: string): Promise<void> {
    const publicKey = (await this.dependencies.io.readFile(this.dependencies.paths.publicKey)).trim();
    const entry = `${KEY_PREFIX}${publicKey}`;
    const command = `tmp=$(mktemp) && (grep -vxF ${shellQuote(entry)} ~/.ssh/authorized_keys > "$tmp" || true) && cat "$tmp" > ~/.ssh/authorized_keys && rm -f "$tmp"`;
    await this.dependencies.io.run('ssh', [...this.controlArgs(target, controlPath), target.destination, command], { env: this.cleanEnv(), timeoutMs: EXEC_TIMEOUT_MS });
  }
  private async exitMaster(target: SshTarget, controlPath: string): Promise<void> {
    await this.dependencies.io.run('ssh', [...this.controlArgs(target, controlPath), '-O', 'exit', target.destination], { env: this.cleanEnv(), timeoutMs: EXEC_TIMEOUT_MS });
  }
  private watch(peerId: string, managed: ActiveTunnel): void {
    managed.process.once('exit', () => {
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
    if (managed.restarts >= max) { this.active.delete(peerId); this.dependencies.report?.('TUNNEL_FAILED', peerId); return; }
    const delay = Math.min(30_000, 1_000 * (2 ** managed.restarts)); managed.restarts += 1;
    managed.restartTimer = this.dependencies.scheduler.schedule(delay, () => {
      if (managed.stopping || this.active.get(peerId) !== managed) return;
      try {
        const target = parseSshTarget(managed.record.sshTarget);
        const launch = this.spawnTunnel(target, managed.record.localPort, this.recordControlPath(managed.record), true);
        managed.process = launch.process; this.watch(peerId, managed);
        void this.awaitReady(launch, managed.record.localPort).then(() => this.scheduleHealthyReset(peerId, managed), () => this.scheduleRestart(peerId, managed));
      } catch (error) { this.scheduleRestart(peerId, managed); }
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
