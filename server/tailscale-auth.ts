import { appConfigDb } from '@/modules/database/index.js';

export const TAILSCALE_LOGIN_HEADER = 'tailscale-user-login';
export const TAILSCALE_NAME_HEADER = 'tailscale-user-name';
export const TAILSCALE_OWNER_KEY = 'tailscale_auth_owner';
export const TAILSCALE_ALLOWED_KEY = 'tailscale_auth_allowed';

type ConfigStore = Pick<typeof appConfigDb, 'get' | 'set'>;

export type TailscaleAccessRole = 'owner' | 'user' | null;

export type TailscaleAccessConfig = {
  owner: string | null;
  users: string[];
};

type RequestLike = {
  headers?: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string | null };
};

const LOGIN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._@+:-]{0,319}$/;

export function normalizeTailscaleLogin(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return LOGIN_PATTERN.test(normalized) ? normalized : null;
}

function parseAllowedUsers(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.map(normalizeTailscaleLogin).filter((value): value is string => value !== null))].sort();
  } catch {
    return [];
  }
}

export function getTailscaleAccessConfig(store: ConfigStore = appConfigDb): TailscaleAccessConfig {
  const owner = normalizeTailscaleLogin(store.get(TAILSCALE_OWNER_KEY));
  const allowed = parseAllowedUsers(store.get(TAILSCALE_ALLOWED_KEY));
  const users = owner ? [...new Set([owner, ...allowed])].sort() : allowed;
  return { owner, users };
}

export function setTailscaleOwner(login: string, store: ConfigStore = appConfigDb): TailscaleAccessConfig {
  const normalized = normalizeTailscaleLogin(login);
  if (!normalized) throw new Error('A valid Tailscale login name is required');
  const current = getTailscaleAccessConfig(store);
  store.set(TAILSCALE_OWNER_KEY, normalized);
  store.set(TAILSCALE_ALLOWED_KEY, JSON.stringify([...new Set([normalized, ...current.users])].sort()));
  return getTailscaleAccessConfig(store);
}

export function allowTailscaleUser(login: string, store: ConfigStore = appConfigDb): TailscaleAccessConfig {
  const normalized = normalizeTailscaleLogin(login);
  if (!normalized) throw new Error('A valid Tailscale login name is required');
  const current = getTailscaleAccessConfig(store);
  if (!current.owner) throw new Error('Set a Tailscale owner before allowing users');
  store.set(TAILSCALE_ALLOWED_KEY, JSON.stringify([...new Set([...current.users, normalized])].sort()));
  return getTailscaleAccessConfig(store);
}

export function revokeTailscaleUser(login: string, store: ConfigStore = appConfigDb): TailscaleAccessConfig {
  const normalized = normalizeTailscaleLogin(login);
  if (!normalized) throw new Error('A valid Tailscale login name is required');
  const current = getTailscaleAccessConfig(store);
  if (normalized === current.owner) throw new Error('The Tailscale owner cannot be revoked');
  store.set(TAILSCALE_ALLOWED_KEY, JSON.stringify(current.users.filter((user) => user !== normalized)));
  return getTailscaleAccessConfig(store);
}

export function getTailscaleAccessRole(login: string, store: ConfigStore = appConfigDb): TailscaleAccessRole {
  const normalized = normalizeTailscaleLogin(login);
  if (!normalized) return null;
  const config = getTailscaleAccessConfig(store);
  if (normalized === config.owner) return 'owner';
  return config.users.includes(normalized) ? 'user' : null;
}

export function isLoopbackAddress(address: string | null | undefined): boolean {
  if (!address) return false;
  const normalized = address.toLowerCase().split('%')[0];
  return normalized === '127.0.0.1' || normalized === '::1' || normalized === '::ffff:127.0.0.1';
}

function firstHeader(headers: RequestLike['headers'], name: string): string | null {
  const value = headers?.[name];
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.length === 1) return value[0];
  return null;
}

export function isLoopbackHost(hostHeader: unknown): boolean {
  if (typeof hostHeader !== 'string') return false;
  try {
    const url = new URL(`http://${hostHeader}`);
    return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  } catch {
    return false;
  }
}

export function isTailscaleServeHost(hostHeader: unknown): boolean {
  if (typeof hostHeader !== 'string') return false;
  try {
    const hostname = new URL(`https://${hostHeader}`).hostname.toLowerCase();
    return hostname.endsWith('.ts.net') && hostname.length > '.ts.net'.length;
  } catch {
    return false;
  }
}

function isSameOrigin(headers: RequestLike['headers'], host: string, protocol: 'http:' | 'https:'): boolean {
  const origin = firstHeader(headers, 'origin');
  if (!origin) return true;
  try {
    const originUrl = new URL(origin);
    const requestUrl = new URL(`${protocol}//${host}`);
    return originUrl.protocol === protocol && originUrl.host === requestUrl.host;
  } catch {
    return false;
  }
}

export type TailscaleRequestIdentity = {
  login: string | null;
  name: string | null;
  role: TailscaleAccessRole | 'local';
  source: 'local' | 'tailscale';
};

export function authenticateTailscaleRequest(
  request: RequestLike,
  store: ConfigStore = appConfigDb,
): TailscaleRequestIdentity | null {
  const remoteAddress = request.socket?.remoteAddress;
  if (!isLoopbackAddress(remoteAddress)) return null;

  const host = firstHeader(request.headers, 'host');
  const isLocalHost = isLoopbackHost(host);
  const isServeHost = isTailscaleServeHost(host);
  if (!host || (!isLocalHost && !isServeHost)) return null;
  if (!isSameOrigin(request.headers, host, isServeHost ? 'https:' : 'http:')) return null;
  if (isLocalHost) {
    return { login: null, name: null, role: 'local', source: 'local' };
  }

  const login = normalizeTailscaleLogin(firstHeader(request.headers, TAILSCALE_LOGIN_HEADER));
  if (!login) return null;
  const role = getTailscaleAccessRole(login, store);
  if (!role) return null;

  const rawName = firstHeader(request.headers, TAILSCALE_NAME_HEADER);
  const name = rawName && rawName.length <= 200 && !/[\r\n\0]/.test(rawName) ? rawName.trim() || null : null;
  return { login, name, role, source: 'tailscale' };
}
