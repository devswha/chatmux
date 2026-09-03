import { spawn } from 'node:child_process';
import { createConnection, createServer } from 'node:net';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';

export type SshProcessOptions = Readonly<{
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}>;
export type SshRunResult = Readonly<{ code: number | null; stdout: string; stderr: string }>;
export interface SshProcess {
  readonly pid: number;
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  stop(signal: NodeJS.Signals): void;
}
export interface SshTunnelIo {
  allocatePort(): Promise<number>;
  fileExists(path: string): Promise<boolean>;
  mkdir(path: string, mode: number): Promise<void>;
  mkdtemp(prefix: string): Promise<string>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, data: string, mode: number): Promise<void>;
  rm(path: string): Promise<void>;
  run(command: string, args: readonly string[], options: SshProcessOptions): Promise<SshRunResult>;
  spawn(command: string, args: readonly string[], options: SshProcessOptions): SshProcess;
  waitUntilReady(port: number, timeoutMs: number): Promise<void>;
  killGroup(pid: number, signal: NodeJS.Signals): void;
}

class RealSshProcess implements SshProcess {
  readonly pid: number;
  private exit?: readonly [number | null, NodeJS.Signals | null];
  private exitListener?: (code: number | null, signal: NodeJS.Signals | null) => void;
  constructor(private readonly child: ReturnType<typeof spawn>) {
    if (child.pid === undefined) throw new TypeError('SSH process did not receive a pid');
    this.pid = child.pid;
    child.once('error', () => this.captureExit(null, null));
    child.once('exit', (code, signal) => this.captureExit(code, signal));
  }
  private captureExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exit !== undefined) return;
    this.exit = [code, signal];
    this.exitListener?.(code, signal);
  }
  once(_event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown {
    this.exitListener = listener;
    if (this.exit !== undefined) queueMicrotask(() => listener(...this.exit!));
    return this;
  }
  stop(signal: NodeJS.Signals): void {
    try { process.kill(process.platform === 'win32' ? this.pid : -this.pid, signal); }
    catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ESRCH') throw error;
    }
  }
}

function allocatePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') { server.close(); reject(new TypeError('loopback port allocation failed')); return; }
      server.close((error) => error === undefined ? resolve(address.port) : reject(error));
    });
  });
}

function waitUntilReady(port: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    let timer: NodeJS.Timeout | undefined;
    const attempt = (): void => {
      const socket = createConnection({ host: '127.0.0.1', port });
      const finish = (error?: Error): void => {
        socket.destroy();
        if (error === undefined) { if (timer !== undefined) clearTimeout(timer); resolve(); return; }
        if (Date.now() >= deadline) { reject(new Error('SSH tunnel readiness timed out')); return; }
        timer = setTimeout(attempt, 25);
      };
      socket.once('connect', () => finish());
      socket.once('error', (error) => finish(error));
    };
    attempt();
  });
}

function run(command: string, args: readonly string[], options: SshProcessOptions): Promise<SshRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: options.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; let settled = false;
    const finish = (result: SshRunResult): void => { if (settled) return; settled = true; clearTimeout(timer); resolve(result); };
    const fail = (error: Error): void => { if (settled) return; settled = true; clearTimeout(timer); reject(error); };
    const timer = setTimeout(() => {
      if (child.pid !== undefined) process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL');
      finish({ code: null, stdout: '', stderr: 'timeout' });
    }, options.timeoutMs ?? 15_000);
    child.once('error', fail);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { if (stdout.length < 65_536) stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { if (stderr.length < 65_536) stderr += chunk; });
    child.once('exit', (code) => finish({ code, stdout, stderr }));
  });
}

export const realSshTunnelIo: SshTunnelIo = {
  allocatePort,
  fileExists: async (path) => access(path).then(() => true, () => false),
  mkdir: async (path, mode) => { await mkdir(path, { recursive: true, mode }); },
  mkdtemp,
  readFile: (path) => readFile(path, 'utf8'),
  writeFile: async (path, data, mode) => { await writeFile(path, data, { mode }); },
  rm: async (path) => { await rm(path, { recursive: true, force: true }); },
  run,
  spawn: (command, args, options) => new RealSshProcess(spawn(command, args, { env: options.env, detached: true, stdio: 'ignore' })),
  waitUntilReady,
  killGroup: (pid, signal) => process.kill(process.platform === 'win32' ? pid : -pid, signal),
};
