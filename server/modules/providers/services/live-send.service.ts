/** Optional control-tower integration for creating a new GJC tmux session. */

import { builtinRelayEnabled, builtinSpawn } from './builtin-relay.service.js';

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
