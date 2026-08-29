import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import type { TmuxFleetNode } from '../../server/modules/providers/tests/support/tmux-e2e-harness.js';

const execFileAsync = promisify(execFile);
const START_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 5_000;

type PidExitWaiter = Readonly<{ ready: Promise<void>; exited: Promise<void> }>;

export type FleetProcess = Readonly<{
  role: 'hub' | 'peer';
  hostId: string;
  pid: number;
  processGroupPid: number;
  listenerPid: number;
  port: number;
  url: string;
  logPath: string;
  health: Readonly<{ status: number; body: unknown }>;
  child: ChildProcess;
  listenerExit: PidExitWaiter;
  closeLog: () => Promise<void>;
}>;

export class FleetProcessError extends Error {
  constructor(message: string, readonly logPath: string) {
    super(`${message}; log: ${logPath}`);
    this.name = 'FleetProcessError';
  }
}

export function waitForOutput(child: ChildProcess, marker: RegExp, logPath: string): Promise<void> {
  // The child's stdout is already piped into the log file by the caller. Poll the
  // file instead of attaching another data listener: a second listener on an
  // already-flowing piped stream can miss early chunks on loaded CI hosts and
  // time out even though the marker reached the log.
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(timeout);
      child.off('exit', onExit);
      if (error) reject(error); else resolve();
    };
    const poll = setInterval(() => {
      void readFile(logPath, 'utf8').then((text) => {
        if (!settled && marker.test(text)) finish();
      }, () => undefined);
    }, 200);
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      finish(new FleetProcessError(`Process exited before readiness (${code ?? signal ?? 'unknown'})`, logPath));
    };
    const timeout = setTimeout(
      () => finish(new FleetProcessError('Process readiness timed out', logPath)),
      START_TIMEOUT_MS,
    );
    child.once('exit', onExit);
  });
}

async function ownedListener(processGroupId: number, logPath: string): Promise<Readonly<{ pid: number; port: number }>> {
  const [processes, sockets] = await Promise.all([
    execFileAsync('ps', ['-eo', 'pid=,pgid='], { encoding: 'utf8', timeout: 5_000 }),
    execFileAsync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpn'], { encoding: 'utf8', timeout: 5_000 }),
  ]);
  const groupPids = new Set(String(processes.stdout).split('\n').flatMap((line) => {
    const [pidValue, groupValue] = line.trim().split(/\s+/).map(Number);
    return pidValue !== undefined && groupValue === processGroupId ? [pidValue] : [];
  }));
  const listeners: { pid: number; port: number }[] = [];
  let currentPid: number | undefined;
  for (const line of String(sockets.stdout).split('\n')) {
    if (/^p\d+$/.test(line)) currentPid = Number(line.slice(1));
    const match = /:(\d+)$/.exec(line);
    if (line.startsWith('n') && match?.[1] !== undefined && currentPid !== undefined && groupPids.has(currentPid)) {
      listeners.push({ pid: currentPid, port: Number(match[1]) });
    }
  }
  const listener = listeners[0];
  if (listeners.length !== 1 || listener === undefined) {
    throw new FleetProcessError(`Listener ownership for process group ${processGroupId} was ambiguous`, logPath);
  }
  return listener;
}

async function health(url: string, logPath: string): Promise<Readonly<{ status: number; body: unknown }>> {
  let response: Response;
  try {
    response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(5_000) });
  } catch (error) {
    throw new FleetProcessError(`Health request failed: ${String(error)}`, logPath);
  }
  if (!response.ok) throw new FleetProcessError(`Health returned ${response.status}`, logPath);
  const body: unknown = await response.json();
  return { status: response.status, body };
}

export async function startFleetServer(
  repositoryRoot: string,
  node: TmuxFleetNode,
  role: 'hub' | 'peer',
  env?: Readonly<NodeJS.ProcessEnv>,
): Promise<FleetProcess> {
  const logPath = path.join(node.logRoot, 'chatmux-server.log');
  await mkdir(path.dirname(logPath), { recursive: true });
  const log = createWriteStream(logPath, { flags: 'w' });
  const tsxCli = path.join(repositoryRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const child = spawn(process.execPath, [tsxCli, '--tsconfig', 'server/tsconfig.json', 'server/index.js'], {
    cwd: repositoryRoot,
    detached: true,
    env: {
      ...node.environment,
      CHATMUX_AUTH: 'none',
      CHATMUX_LIVE_NOTIFY: '0',
      HOST: '127.0.0.1',
      SERVER_PORT: String(node.port),
      // Test-supplied overrides (e.g. live notification monitors) come last.
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.pipe(log, { end: false });
  child.stderr?.pipe(log, { end: false });
  const closeLog = (): Promise<void> => new Promise((resolve, reject) => {
    log.end((error?: Error | null) => error ? reject(error) : resolve());
  });
  const pid = child.pid;
  if (pid === undefined) {
    await closeLog();
    throw new FleetProcessError('Server process has no PID', logPath);
  }
  let listenerExit: PidExitWaiter | undefined;
  try {
    await waitForOutput(child, /Server URL:/, logPath);
    const listener = await ownedListener(pid, logPath);
    listenerExit = createPidExitWaiter(listener.pid);
    await listenerExit.ready;
    const url = `http://127.0.0.1:${listener.port}`;
    return {
      role, hostId: node.hostId, pid: listener.pid, processGroupPid: pid, listenerPid: listener.pid,
      port: listener.port, url, logPath, health: await health(url, logPath), child, listenerExit, closeLog,
    };
  } catch (error) {
    const cleanup = await Promise.allSettled([
      stopProcessGroup(child, 'SIGKILL'),
      ...(listenerExit === undefined ? [] : [listenerExit.exited]),
    ]);
    await closeLog();
    const cleanupFailures = cleanup.filter((result) => result.status === 'rejected').map((result) => result.reason);
    if (cleanupFailures.length > 0) throw new AggregateError([error, ...cleanupFailures], 'Server startup and rollback failed.');
    throw error;
  }
}

export type StartFleetServersOptions = Readonly<{
  startServer?: typeof startFleetServer;
  env?: Readonly<NodeJS.ProcessEnv>;
}>;

export async function startFleetServers(
  repositoryRoot: string,
  nodes: readonly TmuxFleetNode[],
  options: StartFleetServersOptions = {},
): Promise<readonly FleetProcess[]> {
  const startServer = options.startServer ?? startFleetServer;
  const settled = await Promise.allSettled(nodes.map((node) => (
    startServer(repositoryRoot, node, node.name === 'hub' ? 'hub' : 'peer', options.env)
  )));
  const started: FleetProcess[] = [];
  let failure: unknown;
  for (const result of settled) {
    switch (result.status) {
      case 'fulfilled': started.push(result.value); break;
      case 'rejected': failure ??= result.reason; break;
    }
  }
  if (failure === undefined) return started;
  const cleanup = await Promise.allSettled([
    stopFleetProcesses(started, null),
    ...nodes.map((node) => node.dispose()),
  ]);
  const firstNode = nodes[0];
  if (firstNode !== undefined) await rm(path.dirname(firstNode.root), { recursive: true, force: true });
  const cleanupFailures = cleanup.filter((result) => result.status === 'rejected').map((result) => result.reason);
  if (cleanupFailures.length > 0) throw new AggregateError([failure, ...cleanupFailures], 'Fleet startup and rollback failed.');
  throw failure;
}

function createPidExitWaiter(pid: number): PidExitWaiter {
  const code = [
    'import os,select,sys',
    'try: fd=os.pidfd_open(int(sys.argv[1]))',
    "except ProcessLookupError: print('GONE',flush=True); sys.exit(0)",
    "print('READY',flush=True)",
    'select.select([fd],[],[])',
  ].join('\n');
  const waiter = spawn('python3', ['-c', code, String(pid)], { stdio: ['ignore', 'pipe', 'ignore'] });
  const ready = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new FleetProcessError(`PID ${pid} subscription timed out`, 'n/a')), STOP_TIMEOUT_MS);
    waiter.stdout?.once('data', () => { clearTimeout(timeout); resolve(); });
    waiter.once('error', reject);
  });
  const exited = new Promise<void>((resolve, reject) => {
    waiter.once('exit', () => resolve());
    waiter.once('error', reject);
  });
  return { ready, exited };
}

export async function stopProcessGroup(child: ChildProcess | null, signal: NodeJS.Signals = 'SIGINT'): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  const pid = child.pid;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      try { process.kill(-pid, 'SIGKILL'); } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) reject(error);
      }
    }, STOP_TIMEOUT_MS);
    child.once('exit', () => { clearTimeout(timeout); resolve(); });
    try { process.kill(-pid, signal); } catch (error) {
      clearTimeout(timeout);
      if (error instanceof Error && 'code' in error && error.code === 'ESRCH') resolve();
      else reject(error);
    }
  });
}

async function stopFleetProcess(fleetProcess: FleetProcess): Promise<void> {
  const escalation = setTimeout(() => {
    try { process.kill(fleetProcess.listenerPid, 'SIGKILL'); } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
    }
  }, STOP_TIMEOUT_MS);
  try {
    await Promise.all([stopProcessGroup(fleetProcess.child), fleetProcess.listenerExit.exited]);
  } finally {
    clearTimeout(escalation);
    await fleetProcess.closeLog();
  }
}

export async function stopFleetProcesses(processes: readonly FleetProcess[], vite: ChildProcess | null): Promise<void> {
  const settled = await Promise.allSettled([...processes.map(stopFleetProcess), stopProcessGroup(vite)]);
  const failures = settled.filter((result) => result.status === 'rejected').map((result) => result.reason);
  if (failures.length > 0) throw new AggregateError(failures, 'Fleet process cleanup failed.');
}
