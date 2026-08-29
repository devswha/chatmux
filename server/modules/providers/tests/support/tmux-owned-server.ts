import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { watch, type FSWatcher } from 'node:fs';
import { chmod, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { spawn as spawnPty, type IPty } from 'node-pty';

const execFileAsync = promisify(execFile);
const EXIT_TIMEOUT_MS = 5_000;

type OwnedPaneProcess = Readonly<{ pid: number; processGroupId: number; startedAtTicks: string }>;

export class OwnedTmuxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OwnedTmuxError';
  }
}

function processStartTicks(stat: string): string {
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  const value = fields[19];
  if (!value) throw new OwnedTmuxError('Process stat did not contain a start time.');
  return value;
}

async function readOwnedProcess(pid: number): Promise<OwnedPaneProcess> {
  const result = await execFileAsync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8', timeout: 5_000 });
  const processGroupId = Number(String(result.stdout).trim());
  const stat = await import('node:fs/promises').then(({ readFile }) => readFile(`/proc/${pid}/stat`, 'utf8'));
  if (!Number.isSafeInteger(processGroupId)) throw new OwnedTmuxError(`Invalid process group for PID ${pid}.`);
  return { pid, processGroupId, startedAtTicks: processStartTicks(stat) };
}

async function stillOwned(process: OwnedPaneProcess): Promise<boolean> {
  try {
    const stat = await import('node:fs/promises').then(({ readFile }) => readFile(`/proc/${process.pid}/stat`, 'utf8'));
    return processStartTicks(stat) === process.startedAtTicks;
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ESRCH')) return false;
    throw error;
  }
}

type PidExitWaiter = Readonly<{ ready: Promise<void>; exited: Promise<void>; child: ChildProcess }>;

function createPidExitWaiter(pid: number): PidExitWaiter {
  const code = [
    'import os,select,sys',
    'try: fd=os.pidfd_open(int(sys.argv[1]))',
    "except ProcessLookupError: print('GONE',flush=True); sys.exit(0)",
    "print('READY',flush=True)",
    'select.select([fd],[],[])',
  ].join('\n');
  const child = spawn('python3', ['-c', code, String(pid)], { stdio: ['ignore', 'pipe', 'ignore'] });
  const ready = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new OwnedTmuxError(`PID ${pid} exit subscription timed out.`)), EXIT_TIMEOUT_MS);
    child.stdout?.once('data', () => { clearTimeout(timeout); resolve(); });
    child.once('error', reject);
  });
  const exited = new Promise<void>((resolve, reject) => {
    child.once('exit', () => resolve());
    child.once('error', reject);
  });
  return { ready, exited, child };
}

function waitForPtyExit(pty: IPty): Readonly<{ exited: Promise<void>; force: () => void }> {
  let force = (): void => pty.kill('SIGKILL');
  const exited = new Promise<void>((resolve) => {
    const timeout = setTimeout(() => force(), EXIT_TIMEOUT_MS);
    const subscription = pty.onExit(() => {
      clearTimeout(timeout);
      force = (): void => undefined;
      subscription.dispose();
      resolve();
    });
  });
  return { exited, force: () => force() };
}

export type OwnedTmuxServer = Readonly<{
  pid: number;
  socketPath: string;
  run: (args: readonly string[]) => Promise<string>;
  trackPane: (sessionName: string) => Promise<void>;
  dispose: () => Promise<void>;
}>;

export async function startOwnedTmuxServer(
  socketPath: string,
  environment: NodeJS.ProcessEnv,
): Promise<OwnedTmuxServer> {
  await mkdir(path.dirname(socketPath), { recursive: true });
  await chmod(path.dirname(socketPath), 0o700);
  const socketName = path.basename(socketPath);
  let socketReadyResolve: (() => void) | undefined;
  let socketWatcher: FSWatcher | undefined;
  let socketTimeout: NodeJS.Timeout | undefined;
  const socketReady = new Promise<void>((resolve, reject) => {
    socketReadyResolve = resolve;
    socketTimeout = setTimeout(() => reject(new OwnedTmuxError(`Timed out waiting for tmux socket ${socketPath}.`)), EXIT_TIMEOUT_MS);
    socketWatcher = watch(path.dirname(socketPath), { persistent: false }, (_event, filename) => {
      if (filename?.toString() !== socketName) return;
      clearTimeout(socketTimeout);
      socketWatcher?.close();
      resolve();
    });
  });
  const pty = spawnPty('tmux', ['-D', '-S', socketPath, '-f', '/dev/null'], {
    cols: 80,
    rows: 24,
    cwd: path.dirname(socketPath),
    env: environment,
  });
  const earlyExit = pty.onExit(() => socketReadyResolve?.());
  try {
    await socketReady;
  } catch (error) {
    if (socketTimeout !== undefined) clearTimeout(socketTimeout);
    socketWatcher?.close();
    const ptyExit = waitForPtyExit(pty);
    pty.kill('SIGKILL');
    await ptyExit.exited;
    throw error;
  } finally {
    earlyExit.dispose();
  }
  const ownedPanes = new Map<number, OwnedPaneProcess>();
  const run = async (args: readonly string[]): Promise<string> => {
    const result = await execFileAsync('tmux', ['-S', socketPath, ...args], {
      encoding: 'utf8', env: environment, maxBuffer: 1024 * 1024, timeout: 8_000,
    });
    return String(result.stdout);
  };
  let disposed = false;
  return {
    pid: pty.pid,
    socketPath,
    run,
    trackPane: async (sessionName) => {
      const pid = Number((await run(['display-message', '-p', '-t', `=${sessionName}:`, '#{pane_pid}'])).trim());
      if (!Number.isSafeInteger(pid)) throw new OwnedTmuxError(`Invalid pane PID for ${sessionName}.`);
      ownedPanes.set(pid, await readOwnedProcess(pid));
    },
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      const panes = [...ownedPanes.values()];
      const paneExits = panes.map(({ pid }) => createPidExitWaiter(pid));
      await Promise.all(paneExits.map(({ ready }) => ready));
      const ptyExit = waitForPtyExit(pty);
      try { await run(['kill-server']); } catch { pty.kill('SIGTERM'); }
      const escalation = setTimeout(() => {
        for (const owned of panes) {
          void stillOwned(owned).then((ownedNow) => {
            if (!ownedNow) return;
            try { process.kill(-owned.processGroupId, 'SIGKILL'); } catch (error) {
              if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
            }
          });
        }
        ptyExit.force();
      }, EXIT_TIMEOUT_MS);
      await Promise.all([ptyExit.exited, ...paneExits.map(({ exited }) => exited)]);
      clearTimeout(escalation);
      for (const owned of panes) {
        if (await stillOwned(owned)) throw new OwnedTmuxError(`Owned pane PID ${owned.pid} survived tmux shutdown.`);
      }
      try { process.kill(pty.pid, 0); } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return;
        throw error;
      }
      throw new OwnedTmuxError(`Owned tmux server PID ${pty.pid} survived shutdown.`);
    },
  };
}
