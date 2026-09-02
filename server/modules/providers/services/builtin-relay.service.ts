import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';

import { ensureHomeCwd } from './external-cli-sessions/inference-and-spawn.js';
import { recordHostCommand } from './host-command-metrics.service.js';
import type { LiveSpawnResult } from './live-send.service.js';
import { resolveTmuxSpawnLaunch } from './tmux-spawn-scope.service.js';

/**
 * Built-in tmux session creation used when the optional control tower is
 * unreachable. Exact-pane relay and termination live in
 * tmux-pane-actions.service and never pass through this name-based fallback.
 */

export function builtinRelayEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CHATMUX_BUILTIN_RELAY !== '0';
}

const TMUX_TIMEOUT_MS = 5_000;


export interface TmuxRunResult {
  code: number;
  output: string;
}

export type TmuxRunner = (args: string[], stdin?: string) => Promise<TmuxRunResult>;
function tmuxSubcommand(args: readonly string[]): string {
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '-S') { index += 1; continue; }
    if (args[index] === 'tmux') continue; // systemd-run prefix ends with the tmux binary
    if (!args[index].startsWith('-')) return args[index];
  }
  return 'unknown';
}


export function runTmux(args: string[], stdin?: string): Promise<TmuxRunResult> {
  return runCollected('tmux', args, stdin);
}

/**
 * Runs `tmux new-session` (and only that) through a transient systemd scope
 * when ChatMux itself is a systemd service, so a tmux server forked by this
 * spawn does not land in chatmux.service's cgroup and die with it.
 */
export async function runTmuxSpawn(args: string[]): Promise<TmuxRunResult> {
  const launch = await resolveTmuxSpawnLaunch();
  return runCollected(launch.command, [...launch.prefixArgs, ...args]);
}

function runCollected(command: string, args: string[], stdin?: string): Promise<TmuxRunResult> {
  recordHostCommand('tmux', [tmuxSubcommand(args)]);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    let output = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('tmux timed out'));
    }, TMUX_TIMEOUT_MS);
    const collect = (chunk: Buffer) => {
      if (output.length < 64 * 1024) {
        output += chunk.toString('utf8');
      }
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, output: output.trim() });
    });
    if (stdin !== undefined && child.stdin) {
      // A child that exits before draining stdin (tmux gone, or a rejected
      // command) surfaces EPIPE on this stream. Without a handler that is an
      // uncaughtException that can crash the whole server; the exit code from
      // 'close' already reports the failure, so swallow the stream error.
      child.stdin.on('error', () => undefined);
      child.stdin.end(stdin);
    }
  });
}

// tmux rewrites '.' and ':' in a session name to '_' (session_check_name), so
// a name with a dot would be created under a different name than the one the
// duplicate check and the returned tmuxName refer to. Refuse it up front.
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

async function hasSession(name: string, run: TmuxRunner): Promise<boolean> {
  try {
    return (await run(['has-session', '-t', `=${name}`])).code === 0;
  } catch {
    return false;
  }
}


/** Mirrors the tower's cwd contract: expanduser and create a missing directory under $HOME. */
export async function resolveSpawnCwd(cwd: string, home: string = homedir()): Promise<string | null> {
  const trimmed = cwd.trim();
  const expanded = trimmed === '~'
    ? home
    : trimmed.startsWith('~/')
      ? path.join(home, trimmed.slice(2))
      : trimmed;
  return ensureHomeCwd(expanded, home);
}

/** Direct spawn: new detached tmux session at the validated cwd, then boot gjc in it. */
export async function builtinSpawn(
  name: string,
  cwd: string,
  deps: { run?: TmuxRunner; spawnRun?: TmuxRunner; home?: string } = {},
): Promise<LiveSpawnResult> {
  const run = deps.run ?? runTmux;
  // Session creation may fork the tmux server, so it goes through the
  // cgroup-isolating runner; every other command talks to an existing server.
  const spawnRun = deps.spawnRun ?? (deps.run === undefined ? runTmuxSpawn : deps.run);
  const fail = (detail: string): LiveSpawnResult => ({ ok: false, reachable: true, conflict: false, detail });
  if (!NAME_RE.test(name) || name.toLowerCase().startsWith('company')) {
    return fail('잘못된 세션명 (영문·숫자·_·- 만, company*는 예약됨)');
  }
  const resolvedCwd = await resolveSpawnCwd(cwd, deps.home);
  if (!resolvedCwd) {
    return fail('작업 폴더는 홈 아래 생성 가능한 디렉터리만');
  }
  try {
    if (await hasSession(name, run)) {
      return { ok: false, reachable: true, conflict: true, detail: `세션 ${name} 이미 존재` };
    }
    // Start the agent as the pane command. Creating an interactive shell and
    // immediately typing into it races shell initialization and can lose the
    // boot command while still reporting a successful spawn.
    const created = await spawnRun(['new-session', '-d', '-s', name, '-c', resolvedCwd, 'gjc']);
    if (created.code !== 0) {
      return fail(`tmux 세션 생성 실패: ${created.output.slice(0, 200)}`);
    }
    return { ok: true, reachable: true, conflict: false, detail: `내장 릴레이로 생성됨 — ${name} @ ${resolvedCwd}` };
  } catch (error) {
    return fail(`tmux 실행 실패: ${error instanceof Error ? error.message : 'unknown'}`);
  }
}
