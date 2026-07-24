import { spawn } from 'node:child_process';
import { stat, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import type { LiveSpawnResult } from './live-send.service.js';

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

export function runTmux(args: string[], stdin?: string): Promise<TmuxRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('tmux', args, { stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
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
      child.stdin.end(stdin);
    }
  });
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

async function hasSession(name: string, run: TmuxRunner): Promise<boolean> {
  try {
    return (await run(['has-session', '-t', `=${name}`])).code === 0;
  } catch {
    return false;
  }
}


/** Mirrors the tower's cwd contract: expanduser, must be an existing dir under $HOME. */
export async function resolveSpawnCwd(cwd: string, home: string = homedir()): Promise<string | null> {
  const trimmed = cwd.trim();
  const expanded = trimmed === '~'
    ? home
    : trimmed.startsWith('~/')
      ? path.join(home, trimmed.slice(2))
      : trimmed;
  if (!path.isAbsolute(expanded)) {
    return null;
  }
  try {
    const [real, homeReal] = await Promise.all([realpath(expanded), realpath(home)]);
    if (real !== homeReal && !real.startsWith(`${homeReal}${path.sep}`)) {
      return null;
    }
    return (await stat(real)).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

/** Direct spawn: new detached tmux session at the validated cwd, then boot gjc in it. */
export async function builtinSpawn(
  name: string,
  cwd: string,
  deps: { run?: TmuxRunner; home?: string } = {},
): Promise<LiveSpawnResult> {
  const run = deps.run ?? runTmux;
  const fail = (detail: string): LiveSpawnResult => ({ ok: false, reachable: true, conflict: false, detail });
  if (!NAME_RE.test(name) || name.toLowerCase().startsWith('company')) {
    return fail('잘못된 세션명 (company*는 예약됨)');
  }
  const resolvedCwd = await resolveSpawnCwd(cwd, deps.home);
  if (!resolvedCwd) {
    return fail('작업 폴더는 홈 아래 실존 디렉터리만');
  }
  try {
    if (await hasSession(name, run)) {
      return { ok: false, reachable: true, conflict: true, detail: `세션 ${name} 이미 존재` };
    }
    const created = await run(['new-session', '-d', '-s', name, '-c', resolvedCwd]);
    if (created.code !== 0) {
      return fail(`tmux 세션 생성 실패: ${created.output.slice(0, 200)}`);
    }
    const boot = await run(['send-keys', '-t', `=${name}:`, 'gjc', 'Enter']);
    if (boot.code !== 0) {
      return fail(`gjc 기동 입력 실패: ${boot.output.slice(0, 200)}`);
    }
    return { ok: true, reachable: true, conflict: false, detail: `내장 릴레이로 생성됨 — ${name} @ ${resolvedCwd}` };
  } catch (error) {
    return fail(`tmux 실행 실패: ${error instanceof Error ? error.message : 'unknown'}`);
  }
}
