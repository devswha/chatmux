import { spawn } from 'node:child_process';
import { stat, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import type { LiveKillResult, LiveSendResult, LiveSpawnResult } from './live-send.service.js';

/**
 * Built-in tmux relay — the tower-unreachable fallback (결정 #290 ②).
 *
 * The control tower is an external component that self-host installs do not
 * have, which left every 찔러주기 action (send / spawn / kill) permanently
 * failing with "관제탑 미가동" — a third of the product dead on arrival
 * (실사용자 보고). When the tower cannot be REACHED, the app server now
 * performs the tmux operations directly.
 *
 * Boundary contract:
 * - Tower-first, always: this module only runs when the tower connection
 *   itself fails. A tower REFUSAL (4xx/5xx) is authoritative and is never
 *   retried here — the fallback must not become a bypass.
 * - The route-level safety gates (lineage proof, `$N` generation token,
 *   name validation) run before any relay, so the built-in path inherits the
 *   same protections the tower path has.
 * - Injection uses tmux paste buffers (literal bytes, bracketed paste), never
 *   shell interpolation; every subprocess is argv-spawned without a shell.
 * - `CHATMUX_BUILTIN_RELAY=0` restores the strict tower-only behavior.
 */

export function builtinRelayEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CHATMUX_BUILTIN_RELAY !== '0';
}

const TMUX_TIMEOUT_MS = 5_000;
const PASTE_BUFFER_NAME = 'chatmux-relay';

// Session-target commands (has-session/kill-session) take '=name' for exact
// match; PANE-target commands (send-keys/paste-buffer) need '=name:' — the
// bare '=name' form is rejected with "can't find pane" (실측, tmux 3.2a).

export interface TmuxRunResult {
  code: number;
  output: string;
}

export type TmuxRunner = (args: string[], stdin?: string) => Promise<TmuxRunResult>;

function runTmux(args: string[], stdin?: string): Promise<TmuxRunResult> {
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

/**
 * Direct message injection: load the exact bytes into a private paste buffer,
 * bracket-paste them into the session's active pane, then submit with Enter.
 * Paste (not send-keys -l) so newlines and key-lookalike sequences arrive as
 * literal text in the TUI instead of being interpreted.
 */
export async function builtinSend(tmuxName: string, message: string, run: TmuxRunner = runTmux): Promise<LiveSendResult> {
  const fail = (detail: string): LiveSendResult => ({ ok: false, reachable: true, queued: false, detail });
  if (!NAME_RE.test(tmuxName)) {
    return fail('잘못된 세션명');
  }
  try {
    if (!(await hasSession(tmuxName, run))) {
      return fail(`미지의 세션: ${tmuxName}`);
    }
    const load = await run(['load-buffer', '-b', PASTE_BUFFER_NAME, '-'], message);
    if (load.code !== 0) {
      return fail(`tmux 버퍼 적재 실패: ${load.output.slice(0, 200)}`);
    }
    const paste = await run(['paste-buffer', '-d', '-p', '-b', PASTE_BUFFER_NAME, '-t', `=${tmuxName}:`]);
    if (paste.code !== 0) {
      return fail(`tmux 붙여넣기 실패: ${paste.output.slice(0, 200)}`);
    }
    const enter = await run(['send-keys', '-t', `=${tmuxName}:`, 'Enter']);
    if (enter.code !== 0) {
      return fail(`tmux 전송 실패: ${enter.output.slice(0, 200)}`);
    }
    return { ok: true, reachable: true, queued: false, detail: `내장 릴레이로 전송됨 — ${tmuxName}` };
  } catch (error) {
    return fail(`tmux 실행 실패: ${error instanceof Error ? error.message : 'unknown'}`);
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

/** Direct kill; company* stays reserved exactly like the tower's protection. */
export async function builtinKill(tmuxName: string, run: TmuxRunner = runTmux): Promise<LiveKillResult> {
  const fail = (detail: string): LiveKillResult => ({ ok: false, reachable: true, protected: false, unknown: false, detail });
  if (!NAME_RE.test(tmuxName)) {
    return fail('잘못된 세션명');
  }
  if (tmuxName.toLowerCase().startsWith('company')) {
    return { ok: false, reachable: true, protected: true, unknown: false, detail: `보호 세션 ${tmuxName} — 수동으로만 종료` };
  }
  try {
    if (!(await hasSession(tmuxName, run))) {
      return { ok: false, reachable: true, protected: false, unknown: true, detail: `미지의 세션: ${tmuxName}` };
    }
    const killed = await run(['kill-session', '-t', `=${tmuxName}`]);
    if (killed.code !== 0) {
      return fail(`tmux 종료 실패: ${killed.output.slice(0, 200)}`);
    }
    return { ok: true, reachable: true, protected: false, unknown: false, detail: `내장 릴레이로 종료됨 — ${tmuxName}` };
  } catch (error) {
    return fail(`tmux 실행 실패: ${error instanceof Error ? error.message : 'unknown'}`);
  }
}
