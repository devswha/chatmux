import assert from 'node:assert/strict';
import test from 'node:test';

import { verifyWebSocketClient } from '../modules/websocket/services/websocket-auth.service.js';

import {
  AUTH_COOKIE_NAME,
  getRequestToken,
  isTokenVersionValid,
  parseCookieHeader,
  parseStoredTokenVersion,
  resolveAuthMode,
  resolveSessionDays,
  shouldSlideSession,
  TOKEN_MAX_AGE_MS
} from './auth.js';

test('parses the same-origin auth cookie without corrupting encoded values', () => {
  const cookies = parseCookieHeader(`theme=dark; ${AUTH_COOKIE_NAME}=header%2Epayload%2Esignature; invalid`);

  assert.equal(cookies[AUTH_COOKIE_NAME], 'header.payload.signature');
  assert.equal(cookies.theme, 'dark');
});

test('REST authentication never reads credentials from query parameters', () => {
  assert.equal(getRequestToken({ headers: {}, query: { token: 'query-token' } }), null);
  assert.equal(
    getRequestToken({ headers: { cookie: `${AUTH_COOKIE_NAME}=cookie-token` }, query: { token: 'query-token' } }),
    'cookie-token'
  );
  assert.equal(
    getRequestToken({ headers: { authorization: 'Bearer api-client-token' }, query: { token: 'query-token' } }),
    'api-client-token'
  );
});
test('WebSocket authentication rejects query credentials and accepts the auth cookie', () => {
  let suppliedToken = null;
  const dependencies = {
    authenticateWebSocket: (token) => {
      suppliedToken = token;
      return token === 'cookie-token' ? { userId: 'user-1', username: 'alice' } : null;
    }
  };

  assert.equal(
    verifyWebSocketClient(
      { req: { url: '/ws?token=query-token', headers: { authorization: 'Bearer api-client-token' } } },
      dependencies
    ),
    false
  );
  assert.equal(suppliedToken, null);

  assert.equal(
    verifyWebSocketClient(
      { req: { url: '/ws', headers: { cookie: `${AUTH_COOKIE_NAME}=cookie-token` } } },
      dependencies
    ),
    true
  );
  assert.equal(suppliedToken, 'cookie-token');
});

test('token versions reject credentials issued before logout revocation', () => {
  const versionBeforeLogout = 0;
  const versionAfterLogout = versionBeforeLogout + 1;

  assert.equal(isTokenVersionValid(versionBeforeLogout, versionAfterLogout), false);
  assert.equal(isTokenVersionValid(versionAfterLogout, versionAfterLogout), true);
});

test('legacy tokens are accepted only before a user has a token version', () => {
  assert.equal(isTokenVersionValid(undefined, 0), true);
  assert.equal(isTokenVersionValid(undefined, 1), false);
});

test('persisted token versions reject missing, malformed, and unsafe values', () => {
  assert.equal(parseStoredTokenVersion(null), null);
  assert.equal(parseStoredTokenVersion(''), null);
  assert.equal(parseStoredTokenVersion('-1'), null);
  assert.equal(parseStoredTokenVersion('01'), null);
  assert.equal(parseStoredTokenVersion('not-a-number'), null);
  assert.equal(parseStoredTokenVersion(String(Number.MAX_SAFE_INTEGER + 1)), null);
  assert.equal(parseStoredTokenVersion('0'), 0);
  assert.equal(parseStoredTokenVersion('42'), 42);
});

test('auth mode resolution enables only explicit supported modes', () => {
  assert.equal(resolveAuthMode(undefined), 'none');
  assert.equal(resolveAuthMode(''), 'none');
  assert.equal(resolveAuthMode('none'), 'none');
  assert.equal(resolveAuthMode('PASSWORD'), 'none');
  assert.equal(resolveAuthMode('anything-else'), 'none');
  assert.equal(resolveAuthMode('password'), 'password');
  assert.equal(resolveAuthMode('tailscale'), 'tailscale');
});

test('session length is configurable in whole days and falls back to 7 on junk', () => {
  assert.equal(resolveSessionDays(undefined), 7);
  assert.equal(resolveSessionDays(''), 7);
  assert.equal(resolveSessionDays('not-a-number'), 7);
  assert.equal(resolveSessionDays('0'), 7);
  assert.equal(resolveSessionDays('-3'), 7);
  assert.equal(resolveSessionDays('366'), 7);
  assert.equal(resolveSessionDays('90'), 90);
  assert.equal(resolveSessionDays('90.9'), 90);
  assert.equal(resolveSessionDays('365'), 365);
  assert.equal(resolveSessionDays('1'), 1);
});

test('sliding sessions renew in the second half of the window and never resurrect expired tokens', () => {
  const now = 1_000_000_000_000;
  const toExpSeconds = (remainingMs) => (now + remainingMs) / 1000;
  // Fresh token (full window remaining): no rewrite on every request.
  assert.equal(shouldSlideSession(toExpSeconds(TOKEN_MAX_AGE_MS), now), false);
  // More than half remaining: still no renewal.
  assert.equal(shouldSlideSession(toExpSeconds(TOKEN_MAX_AGE_MS * 0.6), now), false);
  // Under half remaining: renew.
  assert.equal(shouldSlideSession(toExpSeconds(TOKEN_MAX_AGE_MS * 0.4), now), true);
  assert.equal(shouldSlideSession(toExpSeconds(1_000), now), true);
  // Already expired or malformed: never renew.
  assert.equal(shouldSlideSession(toExpSeconds(0), now), false);
  assert.equal(shouldSlideSession(toExpSeconds(-1_000), now), false);
  assert.equal(shouldSlideSession(undefined, now), false);
  assert.equal(shouldSlideSession(Number.NaN, now), false);
});

test('websocket upgrades authenticate as the implicit owner when auth is disabled', () => {
  // Mirrors authenticateWebSocket('none' mode): no cookie, no bearer — still a user.
  const dependencies = {
    authenticateWebSocket: () => ({ userId: 1, username: 'owner' })
  };
  const request = { url: '/ws', headers: {} };
  assert.equal(verifyWebSocketClient({ req: request }, dependencies), true);
  assert.deepEqual(request.user, { userId: 1, username: 'owner' });
});
