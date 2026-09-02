// Login failure limiter keyed on the TCP peer, not on req.ip.
//
// `app.set('trust proxy', 1)` is needed so cookies get the Secure flag behind
// Tailscale Serve or nginx, but it also means a client that connects directly
// (the LAN password mode the installer offers) controls req.ip through
// X-Forwarded-For and could rotate it past any per-IP lockout. The socket
// address cannot be spoofed. A second, looser bucket per username backstops
// distributed guessing without letting one bad neighbour lock the owner out.
export const LOGIN_FAILURE_LIMIT = 10;
export const LOGIN_USERNAME_FAILURE_LIMIT = 40;
export const LOGIN_FAILURE_WINDOW_MS = 15 * 60 * 1000;
export const LOGIN_LIMITER_MAX_ENTRIES = 10_000;

import { limiterClientAddress, normalizePeerAddress } from '../middleware/client-address.js';

export { limiterClientAddress, normalizePeerAddress };

/**
 * @param {{ limit?: number, usernameLimit?: number, windowMs?: number, maxEntries?: number, now?: () => number }} options
 */
export function createLoginLimiter({
  limit = LOGIN_FAILURE_LIMIT,
  usernameLimit = LOGIN_USERNAME_FAILURE_LIMIT,
  windowMs = LOGIN_FAILURE_WINDOW_MS,
  maxEntries = LOGIN_LIMITER_MAX_ENTRIES,
  now = Date.now,
} = {}) {
  /** @type {Map<string, { count: number, resetAt: number }>} */
  const failures = new Map();

  const keys = (address, username) => [
    { key: `peer:${normalizePeerAddress(address)} ${String(username)}`, limit },
    { key: `user:${String(username)}`, limit: usernameLimit },
  ];

  const sweep = (nowMs) => {
    for (const [key, entry] of failures) {
      if (entry.resetAt <= nowMs) failures.delete(key);
    }
    // Still over the cap after dropping expired entries: forget the oldest
    // windows first so memory stays bounded whatever the attacker sends.
    while (failures.size > maxEntries) {
      const oldest = failures.keys().next().value;
      if (oldest === undefined) break;
      failures.delete(oldest);
    }
  };

  /** Seconds the caller must wait, or 0 when a login attempt may proceed. */
  const retryAfterSeconds = (address, username) => {
    const nowMs = now();
    let wait = 0;
    for (const { key, limit: bucketLimit } of keys(address, username)) {
      const entry = failures.get(key);
      if (!entry) continue;
      if (entry.resetAt <= nowMs) { failures.delete(key); continue; }
      if (entry.count >= bucketLimit) wait = Math.max(wait, Math.ceil((entry.resetAt - nowMs) / 1000));
    }
    return wait;
  };

  const recordFailure = (address, username) => {
    const nowMs = now();
    for (const { key } of keys(address, username)) {
      const entry = failures.get(key);
      if (!entry || entry.resetAt <= nowMs) {
        failures.set(key, { count: 1, resetAt: nowMs + windowMs });
      } else {
        entry.count += 1;
      }
    }
    if (failures.size > maxEntries) sweep(nowMs);
  };

  const clear = (address, username) => {
    for (const { key } of keys(address, username)) failures.delete(key);
  };

  return { retryAfterSeconds, recordFailure, clear, size: () => failures.size };
}
