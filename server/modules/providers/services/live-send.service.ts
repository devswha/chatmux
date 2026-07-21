/**
 * Relays a message from the app into a live tmux gjc session via the control
 * tower's send endpoint — the app never injects into the conversation directly
 * while a tower is present. The tower owns outbox/queueing, paste injection,
 * and send verification; we proxy `POST {TOWER_URL}/send`.
 *
 * Tower dependence is ISOLATED here. When the tower cannot be REACHED (self-
 * host installs have none — the tower is an external component), the built-in
 * relay performs the tmux operation directly instead (결정 #290 ②), so 찔러주기
 * works out of the box. A tower REFUSAL is authoritative and never falls back.
 * `CHATMUX_BUILTIN_RELAY=0` restores the strict tower-only degradation
 * (`{ ok: false, reachable: false }`).
 */

import { builtinKill, builtinRelayEnabled, builtinSend, builtinSpawn } from './builtin-relay.service.js';

const DEFAULT_TOWER_URL = 'http://127.0.0.1:3019';

export function towerUrl(): string {
  return process.env.TOWER_URL || DEFAULT_TOWER_URL;
}

// tmux session names are simple tokens; reject anything that could be an argv/shell
// surprise before it reaches the tower (the tower validates too — defence in depth).
const TMUX_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function isValidTmuxName(name: unknown): name is string {
  return typeof name === 'string' && TMUX_NAME_RE.test(name);
}

export type LiveSendResult = { ok: boolean; reachable: boolean; queued: boolean; detail: string };

/** Pure classifier for the tower's response (queued vs delivered vs failure). */
export function classifyTowerResponse(status: number, body: string): LiveSendResult {
  const detail = body.trim().slice(0, 500);
  const ok = status >= 200 && status < 300;
  return {
    ok,
    reachable: true,
    queued: ok && /queue|queued|대기/i.test(detail),
    detail,
  };
}

/** Proxies one message to the tower's /send. Never throws — returns a result. */
export async function sendToLiveSession(tmuxName: string, message: string): Promise<LiveSendResult> {
  const body = new URLSearchParams({ session: tmuxName, msg: message });
  let response: Response;
  try {
    response = await fetch(`${towerUrl()}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(6000),
    });
  } catch {
    if (builtinRelayEnabled()) {
      return builtinSend(tmuxName, message);
    }
    return { ok: false, reachable: false, queued: false, detail: 'control tower is not reachable' };
  }
  const text = await response.text().catch(() => '');
  return classifyTowerResponse(response.status, text);
}

// ─── Spawn a new tmux gjc session (control tower /spawn) ─────────────────────
// The tower validates authoritatively (alphanumeric name, no reserved 'company',
// cwd under $HOME, no duplicate → 409) and creates the tmux session + boots gjc.
// The app pre-checks for a friendly error and proxies the rest.

export function isValidSpawnName(name: unknown): name is string {
  return isValidTmuxName(name) && name.toLowerCase() !== 'company';
}

export type LiveSpawnResult = { ok: boolean; reachable: boolean; conflict: boolean; detail: string };

/** Pure classifier for the tower's /spawn response (409 = name already exists). */
export function classifySpawnResponse(status: number, body: string): LiveSpawnResult {
  const detail = body.trim().slice(0, 500);
  const ok = status >= 200 && status < 300;
  return { ok, reachable: true, conflict: status === 409, detail };
}

/**
 * Normalize the spawn form's HOME-relative cwd ("workspace/my-proj") to an
 * explicit "~/workspace/my-proj" before proxying. The tower resolves the value
 * with expanduser + realpath, so a bare relative path would resolve against the
 * tower's own process CWD — which is not necessarily $HOME — and get rejected
 * as "not an existing directory under home". Absolute and "~"-prefixed inputs
 * pass through untouched.
 */
export function normalizeSpawnCwd(cwd: string): string {
  const trimmed = cwd.trim();
  if (trimmed.startsWith('/') || trimmed === '~' || trimmed.startsWith('~/')) {
    return trimmed;
  }
  return `~/${trimmed}`;
}

/** Proxies a spawn request to the tower's /spawn. Never throws — returns a result. */
export async function spawnLiveSession(name: string, cwd: string): Promise<LiveSpawnResult> {
  const body = new URLSearchParams({ name, cwd: normalizeSpawnCwd(cwd) });
  let response: Response;
  try {
    response = await fetch(`${towerUrl()}/spawn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    if (builtinRelayEnabled()) {
      return builtinSpawn(name, normalizeSpawnCwd(cwd));
    }
    return { ok: false, reachable: false, conflict: false, detail: 'control tower is not reachable' };
  }
  const text = await response.text().catch(() => '');
  return classifySpawnResponse(response.status, text);
}

// ─── Kill a live tmux session (control tower /kill) ──────────────────────────
// Fleet lifecycle authority stays with the tower — the app only calls this
// entrance. The tower validates authoritatively (name regex, protected sessions
// [tower's own + company* + TOWER_PROTECTED_SESSIONS] → 403, unknown → 422) and
// runs `tmux kill-session`.

export type LiveKillResult = { ok: boolean; reachable: boolean; protected: boolean; unknown: boolean; detail: string };

/** Pure classifier for the tower's /kill response (403 = protected, 422 = unknown session). */
export function classifyKillResponse(status: number, body: string): LiveKillResult {
  const detail = body.trim().slice(0, 500);
  const ok = status >= 200 && status < 300;
  return { ok, reachable: true, protected: status === 403, unknown: status === 422, detail };
}

/** Proxies a kill request to the tower's /kill. Never throws — returns a result. */
export async function killLiveSession(tmuxName: string): Promise<LiveKillResult> {
  const body = new URLSearchParams({ session: tmuxName });
  let response: Response;
  try {
    response = await fetch(`${towerUrl()}/kill`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    if (builtinRelayEnabled()) {
      return builtinKill(tmuxName);
    }
    return { ok: false, reachable: false, protected: false, unknown: false, detail: 'control tower is not reachable' };
  }
  const text = await response.text().catch(() => '');
  return classifyKillResponse(response.status, text);
}
