import assert from 'node:assert/strict';
import test from 'node:test';

import {
  allowTailscaleUser,
  authenticateTailscaleRequest,
  getTailscaleAccessConfig,
  getTailscaleAccessRole,
  isLoopbackHost,
  normalizeTailscaleLogin,
  revokeTailscaleUser,
  setTailscaleOwner,
} from './tailscale-auth.js';

function createStore() {
  const values = new Map<string, string>();
  return {
    get: (key: string) => values.get(key) ?? null,
    set: (key: string, value: string) => { values.set(key, value); },
  };
}

test('Tailscale allowlist keeps one immutable owner and normalized users', () => {
  const store = createStore();
  setTailscaleOwner('Owner@Example.COM', store);
  allowTailscaleUser('Family+Phone@example.com', store);
  allowTailscaleUser('family+phone@example.com', store);

  assert.deepEqual(getTailscaleAccessConfig(store), {
    owner: 'owner@example.com',
    users: ['family+phone@example.com', 'owner@example.com'],
  });
  assert.equal(getTailscaleAccessRole('OWNER@example.com', store), 'owner');
  assert.equal(getTailscaleAccessRole('family+phone@example.com', store), 'user');
  assert.throws(() => revokeTailscaleUser('owner@example.com', store), /cannot be revoked/);
  assert.deepEqual(revokeTailscaleUser('family+phone@example.com', store).users, ['owner@example.com']);
});

test('Tailscale login normalization rejects spoofable or malformed values', () => {
  assert.equal(normalizeTailscaleLogin(' Alice@example.com '), 'alice@example.com');
  assert.equal(normalizeTailscaleLogin('alice example.com'), null);
  assert.equal(normalizeTailscaleLogin('alice@example.com\r\nadmin@example.com'), null);
  assert.equal(normalizeTailscaleLogin(''), null);
});

test('Tailscale request authentication trusts Serve headers only from loopback on ts.net hosts', () => {
  const store = createStore();
  setTailscaleOwner('owner@example.com', store);
  const trustedHeaders = {
    host: 'home-server.example.ts.net:8443',
    'tailscale-user-login': 'OWNER@example.com',
    'tailscale-user-name': 'Owner',
  };

  assert.deepEqual(authenticateTailscaleRequest({
    socket: { remoteAddress: '127.0.0.1' },
    headers: trustedHeaders,
  }, store), {
    login: 'owner@example.com',
    name: 'Owner',
    role: 'owner',
    source: 'tailscale',
  });
  assert.equal(authenticateTailscaleRequest({
    socket: { remoteAddress: '100.64.0.2' },
    headers: trustedHeaders,
  }, store), null, 'a direct remote client cannot spoof the identity header');
  assert.equal(authenticateTailscaleRequest({
    socket: { remoteAddress: '127.0.0.1' },
    headers: { ...trustedHeaders, host: 'attacker.example' },
  }, store), null, 'a loopback proxy with an unrelated host is not Tailscale Serve');
  assert.equal(authenticateTailscaleRequest({
    socket: { remoteAddress: '127.0.0.1' },
    headers: { ...trustedHeaders, origin: 'https://malicious.example' },
  }, store), null, 'cross-origin browser requests cannot inherit the Tailscale user');
  assert.equal(authenticateTailscaleRequest({
    socket: { remoteAddress: '127.0.0.1' },
    headers: { ...trustedHeaders, origin: 'http://home-server.example.ts.net:8443' },
  }, store), null, 'the Tailscale browser origin must use HTTPS');
  assert.equal(authenticateTailscaleRequest({
    socket: { remoteAddress: '127.0.0.1' },
    headers: { ...trustedHeaders, origin: 'https://home-server.example.ts.net:8443' },
  }, store)?.role, 'owner');
  assert.equal(authenticateTailscaleRequest({
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: trustedHeaders.host },
  }, store), null, 'tagged devices without a user header fail closed');
});

test('local direct access remains an owner recovery path without accepting DNS rebinding hosts', () => {
  const store = createStore();
  assert.deepEqual(authenticateTailscaleRequest({
    socket: { remoteAddress: '::ffff:127.0.0.1' },
    headers: { host: '127.0.0.1:3001' },
  }, store), { login: null, name: null, role: 'local', source: 'local' });
  assert.equal(isLoopbackHost('[::1]:3001'), true);
  assert.equal(authenticateTailscaleRequest({
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: 'malicious.example' },
  }, store), null);
});
