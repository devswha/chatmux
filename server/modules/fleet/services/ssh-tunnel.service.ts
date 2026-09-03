import { dirname, join } from 'node:path';

import { fleetSshTunnelsDb, getDatabasePath, type FleetSshTunnelRecord } from '@/modules/database/index.js';
import { InvalidSshTargetError, parseSshTarget, type SshTarget } from '@/modules/fleet/services/ssh-target.js';
import {
  realSshTunnelIo,
  type SshProcess,
  type SshRunResult,
  type SshTunnelIo,
} from '@/modules/fleet/services/ssh-tunnel-io.js';

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
  | 'INVALID_SSH_TARGET' | 'SSH_PASSWORD_REQUIRED' | 'SSH_AUTH_FAILED' | 'SSH_UNREACHABLE'
  | 'HOSTKEY_REJECTED' | 'REMOTE_CLI_FAILED' | 'TOKEN_PARSE_FAILED' | 'ENROLL_FAILED'
  | 'PEER_LIMIT_REACHED' | 'TUNNEL_FAILED';

export class SshEnrollmentError extends Error {
  readonly name = 'SshEnrollmentError';
  constructor(readonly code: SshEnrollmentErrorCode, message: string) { super(message); }
}

type Scheduler = Readonly<{ schedule(delayMs: number, callback: () => void): Readonly<{ cancel(): void }> }>;
type TunnelPaths = Readonly<{ directory: string; privateKey: string; publicKey: string; knownHosts: string }>;
type ManagerDependencies = Readonly<{
  io: SshTunnelIo;
  store: SshTunnelStore;
  paths: TunnelPaths;
  scheduler: Scheduler;
  maxRestartAttempts?: number;
}>;
type ActiveTunnel = {
  process: SshProcess;
  readonly record: SshTunnelRecord;
  restarts: number;
  stopping: boolean;
  restartTimer?: Readonly<{ cancel(): void }>;
};
export type PreparedSshTunnel = Readonly<{
  localPort: number;
  token: string;
  complete(peerId: string): void;
  abort(): void;
}>;

const REMOTE_FLEET_PORT = 3001;
const TOKEN_LINE = /^Pairing token: ([A-Za-z0-9_-]{43})$/m;
const EXEC_TIMEOUT_MS = 15_000;

function shellQuote(value: string): string { return `'${value.replaceAll("'", `'"'"'`)}'`; }

function classify(result: SshRunResult, fallback: 'REMOTE_CLI_FAILED' | 'TUNNEL_FAILED'): SshEnrollmentError {
  const diagnostic = result.stderr.toLowerCase();
  if (diagnostic.includes('permission denied') || diagnostic.includes('authentication failed')) return new SshEnrollmentError('SSH_AUTH_FAILED', 'SSH authentication failed');
  if (diagnostic.includes('connection timed out') || diagnostic.includes('no route to host') || diagnostic.includes('connection refused') || result.code === null) return new SshEnrollmentError('SSH_UNREACHABLE', 'SSH target is unreachable');
  if (diagnostic.includes('host key verification failed') || diagnostic.includes('remote host identification has changed')) return new SshEnrollmentError('HOSTKEY_REJECTED', 'SSH host key was rejected');
  return new SshEnrollmentError(fallback, fallback === 'REMOTE_CLI_FAILED' ? 'Remote ChatMux CLI failed' : 'SSH tunnel failed');
}

export class SshTunnelManager {
  private readonly active = new Map<string, ActiveTunnel>();
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
    await this.ensureKey();
    const localPort = existing?.localPort ?? await this.dependencies.io.allocatePort();
    const password = input.password === undefined || input.password.length === 0 ? undefined : input.password;
    let tunnelAskpass: Readonly<{ directory: string; script: string }> | undefined;
    let installAskpass: Readonly<{ directory: string; script: string }> | undefined;
    let child: SshProcess | undefined;
    let completed = false;
    try {
      tunnelAskpass = password === undefined ? undefined : await this.createAskpass(password);
      child = this.spawnTunnel(target, localPort, tunnelAskpass?.script);
      if (password !== undefined) {
        installAskpass = await this.createAskpass(password);
        await this.installKey(target, installAskpass.script);
      }
      const token = await this.mintToken(target);
      const tunnel = child;
      return {
        localPort,
        token,
        complete: (peerId) => {
          if (completed) return;
          completed = true;
          const record = { peerId, sshTarget: target.sshTarget, localPort, ...(target.sshPort === undefined ? {} : { sshPort: target.sshPort }) };
          this.dependencies.store.save(record);
          const managed: ActiveTunnel = { process: tunnel, record, restarts: 0, stopping: false };
          this.active.set(peerId, managed); this.watch(peerId, managed);
        },
        abort: () => { if (!completed) tunnel.stop('SIGTERM'); },
      };
    } catch (error) {
      child?.stop('SIGTERM'); throw error;
    } finally {
      if (installAskpass !== undefined) await this.dependencies.io.rm(installAskpass.directory);
      if (tunnelAskpass !== undefined) await this.dependencies.io.rm(tunnelAskpass.directory);
    }
  }

  async remove(peerId: string): Promise<void> {
    const record = this.dependencies.store.findByPeerId(peerId);
    const managed = this.active.get(peerId);
    if (managed !== undefined) {
      managed.stopping = true; managed.restartTimer?.cancel(); managed.process.stop('SIGTERM'); this.active.delete(peerId);
    }
    if (record === undefined) return;
    this.dependencies.store.delete(peerId);
    const target = parseSshTarget(record.sshTarget);
    const publicKey = (await this.dependencies.io.readFile(this.dependencies.paths.publicKey)).trim();
    const command = `tmp=$(mktemp) && (grep -vxF ${shellQuote(publicKey)} ~/.ssh/authorized_keys > "$tmp" || true) && cat "$tmp" > ~/.ssh/authorized_keys && rm -f "$tmp"`;
    await this.dependencies.io.run('ssh', [...this.execArgs(target), command], { timeoutMs: EXEC_TIMEOUT_MS });
  }

  async restore(): Promise<void> {
    try { await this.ensureKey(); }
    catch (error) {
      if (!(error instanceof Error)) throw error;
      return;
    }
    for (const record of this.dependencies.store.list()) {
      if (this.active.has(record.peerId)) continue;
      try {
        const target = parseSshTarget(record.sshTarget);
        const managed: ActiveTunnel = { process: this.spawnTunnel(target, record.localPort), record, restarts: 0, stopping: false };
        this.active.set(record.peerId, managed); this.watch(record.peerId, managed);
      } catch (error) {
        if (!(error instanceof Error)) throw error;
      }
    }
  }

  stop(): void {
    for (const managed of this.active.values()) { managed.stopping = true; managed.restartTimer?.cancel(); managed.process.stop('SIGTERM'); }
    this.active.clear();
  }

  private async ensureKey(): Promise<void> {
    await this.dependencies.io.mkdir(this.dependencies.paths.directory, 0o700);
    if (await this.dependencies.io.fileExists(this.dependencies.paths.privateKey)) return;
    const result = await this.dependencies.io.run('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', 'chatmux-fleet-tunnel', '-f', this.dependencies.paths.privateKey], { timeoutMs: EXEC_TIMEOUT_MS });
    if (result.code !== 0) throw classify(result, 'TUNNEL_FAILED');
  }

  private async createAskpass(password: string): Promise<Readonly<{ directory: string; script: string }>> {
    const directory = await this.dependencies.io.mkdtemp(join(this.dependencies.paths.directory, 'askpass-'));
    const script = join(directory, 'askpass');
    await this.dependencies.io.writeFile(script, `#!/bin/sh\ntrap 'rm -f -- "$0"' EXIT\nprintf '%s\\n' ${shellQuote(password)}\n`, 0o600);
    return { directory, script };
  }

  private commonArgs(target: SshTarget): string[] {
    return ['-o', 'StrictHostKeyChecking=accept-new', '-o', `UserKnownHostsFile=${this.dependencies.paths.knownHosts}`, '-i', this.dependencies.paths.privateKey, ...(target.sshPort === undefined ? [] : ['-p', String(target.sshPort)])];
  }
  private execArgs(target: SshTarget): string[] { return [...this.commonArgs(target), target.destination]; }
  private spawnTunnel(target: SshTarget, localPort: number, askpass?: string): SshProcess {
    const args = ['-N', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3', ...this.commonArgs(target), '-L', `127.0.0.1:${localPort}:127.0.0.1:${REMOTE_FLEET_PORT}`, target.destination];
    const env = askpass === undefined ? undefined : { ...process.env, SSH_ASKPASS: askpass, SSH_ASKPASS_REQUIRE: 'force', DISPLAY: ':0' };
    return this.dependencies.io.spawn('ssh', args, { ...(env === undefined ? {} : { env }) });
  }
  private async installKey(target: SshTarget, askpass: string): Promise<void> {
    const publicKey = (await this.dependencies.io.readFile(this.dependencies.paths.publicKey)).trim();
    if (!/^ssh-ed25519 [A-Za-z0-9+/]+={0,3}(?: [A-Za-z0-9._-]+)?$/.test(publicKey)) throw new SshEnrollmentError('TUNNEL_FAILED', 'Tunnel public key is invalid');
    const command = `mkdir -p ~/.ssh && chmod 700 ~/.ssh && touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && (grep -qxF ${shellQuote(publicKey)} ~/.ssh/authorized_keys || printf '%s\\n' ${shellQuote(publicKey)} >> ~/.ssh/authorized_keys)`;
    const env = { ...process.env, SSH_ASKPASS: askpass, SSH_ASKPASS_REQUIRE: 'force', DISPLAY: ':0' };
    const result = await this.dependencies.io.run('ssh', [...this.execArgs(target), command], { env, timeoutMs: EXEC_TIMEOUT_MS });
    if (result.code !== 0) throw classify(result, 'TUNNEL_FAILED');
  }
  private async mintToken(target: SshTarget): Promise<string> {
    let result = await this.dependencies.io.run('ssh', [...this.execArgs(target), 'chatmux fleet token'], { timeoutMs: EXEC_TIMEOUT_MS });
    if (result.code === 127 || result.stderr.toLowerCase().includes('command not found')) {
      result = await this.dependencies.io.run('ssh', [...this.execArgs(target), '$HOME/.chatmux/current/dist-server/server/cli.js fleet token'], { timeoutMs: EXEC_TIMEOUT_MS });
    }
    if (result.code !== 0) throw classify(result, 'REMOTE_CLI_FAILED');
    const match = TOKEN_LINE.exec(result.stdout);
    if (match?.[1] === undefined) throw new SshEnrollmentError('TOKEN_PARSE_FAILED', 'Remote ChatMux CLI returned an invalid pairing token');
    return match[1];
  }
  private watch(peerId: string, managed: ActiveTunnel): void {
    managed.process.once('exit', () => {
      if (!managed.stopping && this.active.get(peerId) === managed) this.scheduleRestart(peerId, managed);
    });
  }
  private scheduleRestart(peerId: string, managed: ActiveTunnel): void {
    const max = this.dependencies.maxRestartAttempts ?? 5;
    if (managed.restarts >= max) { this.active.delete(peerId); return; }
    const delay = Math.min(30_000, 1_000 * (2 ** managed.restarts)); managed.restarts += 1;
    managed.restartTimer = this.dependencies.scheduler.schedule(delay, () => {
      if (managed.stopping || this.active.get(peerId) !== managed) return;
      try {
        const target = parseSshTarget(managed.record.sshTarget);
        managed.process = this.spawnTunnel(target, managed.record.localPort); this.watch(peerId, managed);
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        this.scheduleRestart(peerId, managed);
      }
    });
  }
}

const directory = join(dirname(getDatabasePath()), 'fleet-ssh');
export const fleetSshTunnelManager = new SshTunnelManager({
  io: realSshTunnelIo,
  store: fleetSshTunnelsDb,
  paths: { directory, privateKey: join(directory, 'id_ed25519'), publicKey: join(directory, 'id_ed25519.pub'), knownHosts: join(directory, 'known_hosts') },
  scheduler: { schedule: (delayMs, callback) => { const timer = setTimeout(callback, delayMs); timer.unref(); return { cancel: () => clearTimeout(timer) }; } },
});
