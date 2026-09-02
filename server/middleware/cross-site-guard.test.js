import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createCrossSiteGuard,
  isAllowedRequestHost,
  originMatchesRequest,
  parseAllowedHostList,
  requestHostname,
} from './cross-site-guard.js';

test('Origin must name the deployment host, with proxy and dev-server allowances', () => {
  assert.equal(originMatchesRequest(undefined, 'localhost:3001'), true, 'no Origin header is not a cross-site request');
  assert.equal(originMatchesRequest('http://localhost:3001', 'localhost:3001'), true);
  assert.equal(originMatchesRequest('https://home.example.ts.net:8443', 'home.example.ts.net:8443'), true);
  assert.equal(originMatchesRequest('https://chat.example.com', '127.0.0.1:3001', 'chat.example.com'), true, 'a TLS-terminating proxy records the public host');
  assert.equal(originMatchesRequest('https://chat.example.com', '127.0.0.1:3001', 'chat.example.com, internal'), true, 'only the first forwarded host counts');
  assert.equal(originMatchesRequest('http://localhost:5173', 'localhost:3001'), true, 'the Vite dev server proxies from another loopback port');
  assert.equal(originMatchesRequest('http://127.0.0.1:5173', '[::1]:3001'), true);

  assert.equal(originMatchesRequest('https://attacker.example', 'localhost:3001'), false, 'a foreign page cannot drive the API');
  assert.equal(originMatchesRequest('https://attacker.example', '127.0.0.1:3001', 'attacker.example.internal'), false);
  assert.equal(originMatchesRequest('null', 'localhost:3001'), false, 'an opaque origin is rejected');
  assert.equal(originMatchesRequest('file:///etc/passwd', 'localhost:3001'), false);
  assert.equal(originMatchesRequest('http://localhost:3001.attacker.example', 'localhost:3001'), false);
  assert.equal(originMatchesRequest(42, 'localhost:3001'), false);
});

test('Host allowlist accepts loopback, the bind address, ts.net and configured names only', () => {
  assert.equal(isAllowedRequestHost('localhost:3001'), true);
  assert.equal(isAllowedRequestHost('127.0.0.1'), true);
  assert.equal(isAllowedRequestHost('[::1]:3001'), true);
  assert.equal(isAllowedRequestHost('home.example.ts.net:8443'), true);
  assert.equal(isAllowedRequestHost('10.0.0.5:3001', { bindHost: '10.0.0.5' }), true, 'the configured bind address is this deployment');
  assert.equal(isAllowedRequestHost('desktop.lan:3001', { allowedHosts: ['desktop.lan'] }), true);

  assert.equal(isAllowedRequestHost('attacker.example:3001'), false, 'DNS rebinding hosts are refused');
  assert.equal(isAllowedRequestHost('10.0.0.5:3001', { bindHost: '0.0.0.0' }), false, 'a wildcard bind does not whitelist arbitrary hosts');
  assert.equal(isAllowedRequestHost('10.0.0.6:3001', { bindHost: '10.0.0.5' }), false);
  assert.equal(isAllowedRequestHost('localhost.attacker.example'), false);
  assert.equal(isAllowedRequestHost(''), false);
  assert.equal(isAllowedRequestHost(undefined), false);
  assert.equal(isAllowedRequestHost('local host'), false);
});

test('hostname parsing and CHATMUX_ALLOWED_HOSTS parsing are forgiving about ports and separators', () => {
  assert.equal(requestHostname('Desktop.LAN:3001'), 'desktop.lan');
  assert.equal(requestHostname('[::1]:3001'), '[::1]');
  assert.equal(requestHostname('user@host'), null);
  assert.deepEqual(parseAllowedHostList(' desktop.lan:3001, Nas.local\nchat.example.com '), ['desktop.lan', 'nas.local', 'chat.example.com']);
  assert.deepEqual(parseAllowedHostList(undefined), []);
});

test('the guard enforces the Host allowlist only in auth mode none and the Origin check everywhere', () => {
  const none = createCrossSiteGuard({ authMode: 'none', bindHost: '127.0.0.1' });
  assert.deepEqual(none.check({ headers: { host: 'localhost:3001' } }), { ok: true });
  assert.deepEqual(none.check({ headers: { host: 'localhost:3001', origin: 'http://localhost:3001' } }), { ok: true });
  assert.equal(none.check({ headers: { host: 'attacker.example:3001' } }).ok, false, 'rebinding host is refused before any route runs');
  assert.equal(none.check({ headers: { host: 'localhost:3001', origin: 'https://attacker.example' } }).ok, false);

  const password = createCrossSiteGuard({ authMode: 'password', bindHost: '0.0.0.0' });
  assert.deepEqual(password.check({ headers: { host: 'my-desktop:3001' } }), { ok: true }, 'hostname-based LAN access keeps working');
  assert.equal(password.check({ headers: { host: 'my-desktop:3001', origin: 'https://attacker.example' } }).ok, false);

  const tailscale = createCrossSiteGuard({ authMode: 'tailscale', bindHost: '127.0.0.1' });
  assert.deepEqual(tailscale.check({ headers: { host: 'home.example.ts.net:3001', origin: 'https://home.example.ts.net:3001' } }), { ok: true });
});

test('the middleware answers 403 JSON and never calls next for a rejected request', () => {
  const guard = createCrossSiteGuard({ authMode: 'none', bindHost: '127.0.0.1' });
  const responses = [];
  const res = {
    status(code) { this.code = code; return this; },
    json(body) { responses.push({ code: this.code, body }); return this; },
  };
  let nextCalls = 0;
  guard.middleware({ headers: { host: 'localhost:3001', origin: 'https://attacker.example' } }, res, () => { nextCalls += 1; });
  assert.equal(nextCalls, 0);
  assert.deepEqual(responses, [{ code: 403, body: { error: 'Cross-site request rejected.' } }]);
  guard.middleware({ headers: { host: 'localhost:3001' } }, res, () => { nextCalls += 1; });
  assert.equal(nextCalls, 1);
});
