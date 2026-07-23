import assert from 'node:assert/strict';
import test from 'node:test';

import { verifyWebSocketClient } from '../modules/websocket/services/websocket-auth.service.js';

import {
  AUTH_COOKIE_NAME,
  getRequestToken,
  isTokenVersionValid,
  parseCookieHeader,
  parseStoredTokenVersion,
  resolveAuthMode
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

test('websocket upgrades authenticate as the implicit owner when auth is disabled', () => {
  // Mirrors authenticateWebSocket('none' mode): no cookie, no bearer — still a user.
  const dependencies = {
    authenticateWebSocket: () => ({ userId: 1, username: 'owner' })
  };
  const request = { url: '/ws', headers: {} };
  assert.equal(verifyWebSocketClient({ req: request }, dependencies), true);
  assert.deepEqual(request.user, { userId: 1, username: 'owner' });
});
