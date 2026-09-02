import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';

import { recordHostCommand } from '@/modules/providers/services/host-command-metrics.service.js';

type RunOptions = Readonly<{ timeoutMs?: number; env?: NodeJS.ProcessEnv }>;

function runCommand(command: string, cmdArgs: readonly string[], options: RunOptions = {}): Promise<string> {
  const timeoutMs = options.timeoutMs ?? 4_000;
  recordHostCommand(command, cmdArgs);
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...cmdArgs], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, ...(options.env ? { env: options.env } : {}) });
    let stdout = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill('SIGKILL');
        reject(new Error(`${command} timed out`));
      }
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.on('error', (error) => {
      if (!settled) { settled = true; clearTimeout(timer); reject(error); }
    });
    child.on('close', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        if (code === 0) resolve(stdout);
        else reject(new Error(`${command} exited with code ${code ?? 'unknown'}`));
      }
    });
  });
}

/** Parses the portable `ps -o lstart=` fallback format (C locale). */
export function parseProcessStartTime(output: string): number | null {
  const parsed = Date.parse(output.trim());
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Field 22 of /proc/<pid>/stat: the process start time in clock ticks since
 * boot. It is written once by the kernel and never changes for the life of
 * the pid, unlike the /proc/<pid> directory timestamps, which reflect when
 * the procfs inode was last instantiated. The comm field may contain spaces
 * and parentheses, so fields are counted from the last ')'.
 */
export function parseProcStatStartTicks(stat: string): number | null {
  const close = stat.lastIndexOf(')');
  if (close < 0) return null;
  const fields = stat.slice(close + 1).trim().split(/\s+/);
  // fields[0] is field 3 (state); field 22 is therefore index 19.
  const ticks = Number(fields[19]);
  return Number.isSafeInteger(ticks) && ticks >= 0 ? ticks : null;
}

export function parseBootTimeMs(procStat: string): number | null {
  const match = /^btime (\d+)$/m.exec(procStat);
  if (!match) return null;
  const seconds = Number(match[1]);
  return Number.isSafeInteger(seconds) ? seconds * 1000 : null;
}

export type ProcessStartTimeDeps = Readonly<{
  readFile?: (path: string) => Promise<string>;
  run?: (command: string, args: readonly string[], options?: RunOptions) => Promise<string>;
  clockTicksPerSecond?: () => Promise<number>;
}>;

const defaultReadFile = (path: string): Promise<string> => readFile(path, 'utf8');
let clockTicksCache: Promise<number> | undefined;
async function defaultClockTicksPerSecond(run: NonNullable<ProcessStartTimeDeps['run']>): Promise<number> {
  clockTicksCache ??= run('getconf', ['CLK_TCK'], { env: { ...process.env, LC_ALL: 'C' } })
    .then((output) => { const ticks = Number(output.trim()); return Number.isSafeInteger(ticks) && ticks > 0 ? ticks : 100; })
    .catch(() => 100);
  return clockTicksCache;
}

/**
 * Process start time used as the tmux pane/agent generation identity. Derived
 * from the immutable start tick in /proc/<pid>/stat plus the boot time, so it
 * is stable for the life of the pid and PID reuse cannot collide with it. The
 * value crosses the fleet catalog wire as a safe integer. Outside Linux the
 * portable `ps lstart` is parsed in the C locale, because the default locale
 * (Korean on the reference host) produced text Date.parse cannot read.
 */
export async function processStartMs(pid: number, deps: ProcessStartTimeDeps = {}): Promise<number | null> {
  const read = deps.readFile ?? defaultReadFile;
  const run = deps.run ?? runCommand;
  try {
    const [stat, procStat] = await Promise.all([read(`/proc/${pid}/stat`), read('/proc/stat')]);
    const ticks = parseProcStatStartTicks(stat);
    const bootMs = parseBootTimeMs(procStat);
    if (ticks !== null && bootMs !== null) {
      const hz = await (deps.clockTicksPerSecond ?? (() => defaultClockTicksPerSecond(run)))();
      return Math.trunc(bootMs + (ticks * 1000) / hz);
    }
  } catch {
    // Not Linux, or the pid vanished: fall through to the portable form.
  }
  try {
    return parseProcessStartTime(await run('ps', ['-p', String(pid), '-o', 'lstart='], { env: { ...process.env, LC_ALL: 'C' } }));
  } catch {
    return null;
  }
}
