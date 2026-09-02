// Same-site guard for the browser API and WebSocket upgrades.
//
// Two checks, both cheap and header-only:
//   1. Origin must belong to this deployment. A browser attaches `Origin` to
//      every cross-site fetch, every JSON POST and every WebSocket handshake,
//      so a page on another site cannot drive `/api` or `/shell` even in auth
//      mode 'none', where every request is otherwise the implicit owner.
//   2. In auth mode 'none' the Host header must name this deployment. Without
//      it, a DNS-rebinding page (attacker.example resolving to 127.0.0.1) is a
//      same-origin request from the browser's point of view and check 1 never
//      fires. Other modes already bind authority to a cookie or a Tailscale
//      identity, so the allowlist stays off there to keep hostname-based LAN
//      and reverse-proxy setups working.
import { isTailscaleServeHost } from '../tailscale-auth.js';
import { isLoopbackHost, isWildcardHost } from '../../shared/networkHosts.js';

/**
 * @param {unknown} value
 * @returns {string | null} lowercase hostname (IPv6 keeps its brackets) or null
 */
export function requestHostname(value) {
  if (typeof value !== 'string' || !value || /[\s/\\@]/.test(value)) return null;
  try {
    return new URL(`http://${value}`).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** @param {string | null} hostname */
function isLoopbackHostname(hostname) {
  return hostname !== null && LOOPBACK_HOSTNAMES.has(hostname);
}

/**
 * Parses CHATMUX_ALLOWED_HOSTS: comma or whitespace separated hostnames.
 * Ports are ignored; entries that do not parse as a host are dropped.
 *
 * @param {unknown} value
 * @returns {string[]}
 */
export function parseAllowedHostList(value) {
  if (typeof value !== 'string') return [];
  const names = value
    .split(/[\s,]+/)
    .map((entry) => requestHostname(entry.trim()))
    .filter((entry) => entry !== null);
  return [...new Set(names)];
}

/**
 * @param {unknown} hostHeader
 * @param {{ bindHost?: string | null, allowedHosts?: readonly string[] }} options
 */
export function isAllowedRequestHost(hostHeader, { bindHost = null, allowedHosts = [] } = {}) {
  const hostname = requestHostname(hostHeader);
  if (hostname === null) return false;
  if (isLoopbackHostname(hostname)) return true;
  if (isTailscaleServeHost(hostHeader)) return true;
  if (bindHost && !isWildcardHost(bindHost) && !isLoopbackHost(bindHost)) {
    const bound = requestHostname(bindHost.includes(':') && !bindHost.startsWith('[') ? `[${bindHost}]` : bindHost);
    if (bound !== null && bound === hostname) return true;
  }
  return allowedHosts.includes(hostname);
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function firstHeaderValue(value) {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string') return null;
  const first = raw.split(',')[0].trim();
  return first || null;
}

/**
 * True when the request carries no Origin, or when its Origin names this
 * deployment: the same host (with port) as `Host` or as the first
 * `X-Forwarded-Host` a TLS-terminating proxy recorded. Two loopback names on
 * different ports are also accepted so the Vite dev server (:5173) can proxy
 * to the API (:3001) without rewriting Origin.
 *
 * @param {unknown} originHeader
 * @param {unknown} hostHeader
 * @param {unknown} forwardedHostHeader
 */
export function originMatchesRequest(originHeader, hostHeader, forwardedHostHeader = undefined) {
  if (originHeader === undefined) return true;
  if (typeof originHeader !== 'string' || originHeader === 'null') return false;
  let origin;
  try {
    origin = new URL(originHeader);
  } catch {
    return false;
  }
  if (origin.protocol !== 'http:' && origin.protocol !== 'https:') return false;
  const originHost = origin.host.toLowerCase();
  const candidates = [firstHeaderValue(hostHeader), firstHeaderValue(forwardedHostHeader)]
    .filter((candidate) => candidate !== null)
    .map((candidate) => candidate.toLowerCase());
  if (candidates.includes(originHost)) return true;
  return isLoopbackHostname(origin.hostname.toLowerCase()) && isLoopbackHostname(requestHostname(hostHeader));
}

/**
 * @param {object} options
 * @param {'none' | 'password' | 'tailscale'} options.authMode
 * @param {string | null | undefined} [options.bindHost] the HOST the server listens on
 * @param {readonly string[]} [options.allowedHosts] extra hostnames (CHATMUX_ALLOWED_HOSTS)
 * @param {boolean} [options.enforceHostAllowlist] defaults to authMode === 'none'
 */
export function createCrossSiteGuard({ authMode, bindHost = null, allowedHosts = [], enforceHostAllowlist = authMode === 'none' }) {
  const hostOptions = { bindHost, allowedHosts };

  /**
   * @param {{ headers?: Record<string, string | string[] | undefined> }} req
   * @returns {{ ok: true } | { ok: false, error: string }}
   */
  const check = (req) => {
    const headers = req.headers ?? {};
    if (enforceHostAllowlist && !isAllowedRequestHost(headers.host, hostOptions)) {
      return { ok: false, error: 'Request host is not allowed for this deployment.' };
    }
    if (!originMatchesRequest(headers.origin, headers.host, headers['x-forwarded-host'])) {
      return { ok: false, error: 'Cross-site request rejected.' };
    }
    return { ok: true };
  };

  /** Express middleware form of `check`. */
  const middleware = (req, res, next) => {
    const result = check(req);
    if (!result.ok) {
      return res.status(403).json({ error: result.error });
    }
    next();
  };

  return { check, middleware, enforceHostAllowlist };
}
