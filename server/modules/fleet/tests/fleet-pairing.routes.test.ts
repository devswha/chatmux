import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import express from 'express';

import { createFleetPairingRouter } from '@/modules/fleet/fleet-pairing.routes.js';
import { FleetPairingError } from '@/modules/fleet/services/fleet-pairing.service.js';
import { FleetPairingFailureLimiter } from '@/modules/fleet/services/fleet-pairing-limiter.service.js';

const PEER_ID = '00000000-0000-4000-8000-000000000001';
const TOKEN = Buffer.alloc(32, 7).toString('base64url');
const signedIdentity = { descriptor: { installationId: PEER_ID, publicKeyFingerprint: 'fingerprint', protocolVersions: ['fleet/1'] as const, capabilities: [] }, publicKey: 'public-key', signature: 'signature' };
type Fixture = Readonly<{ baseUrl: string; close: () => Promise<void>; calls: string[] }>;

async function startFixture(authMode: 'password' | 'tailscale' = 'password'): Promise<Fixture> {
  const calls: string[] = []; let redeemed = false;
  const app = express(); app.use(express.json({ limit: '16kb' }));
  app.use((request, _response, next) => {
    if (request.headers['x-test-owner'] === 'yes') Object.defineProperty(request, 'user', { value: { id: 1 } });
    if (request.headers['x-test-role'] === 'owner') Object.defineProperty(request, 'user', { value: { id: 1, tailscaleRole: 'owner' } });
    next();
  });
  app.use('/fleet', createFleetPairingRouter({ authMode, limiter: new FleetPairingFailureLimiter(),
    pairing: { issueToken: () => ({ token: TOKEN, expiresAtMs: 1_800_000_600_000 }), redeem: () => { if (redeemed) throw new FleetPairingError('TOKEN_ALREADY_USED', 'used'); redeemed = true; return signedIdentity; }, revokeHubGrant: () => true },
    hubPairing: { enroll: async (input) => { calls.push(`enroll:${input.transportMode}:${input.peerUrl}`); return { peerId: PEER_ID }; } },
    revocation: { remove: async (peerId) => { calls.push(`remove:${peerId}`); return { localRemoval: 'removed' as const, peerRevocation: 'unreachable' as const }; } },
  }));
  const server = createServer(app); await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (address === null || typeof address === 'string') throw new TypeError('test server did not bind TCP');
  return { baseUrl: `http://127.0.0.1:${address.port}/fleet`, calls, close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}

test('owner routes create tokens, enroll peers, and distinguish removal outcomes', async (context) => {
  // Given: a live router and authenticated owner.
  const fixture = await startFixture(); context.after(fixture.close); const owner = { 'content-type': 'application/json', 'x-test-owner': 'yes' };
  // When: token creation, enrollment, and removal use narrow routes.
  const issued = await fetch(`${fixture.baseUrl}/pairing-tokens`, { method: 'POST', headers: owner });
  const enrolled = await fetch(`${fixture.baseUrl}/peers`, { method: 'POST', headers: owner, body: JSON.stringify({ peerUrl: 'wss://peer.example.test/fleet-ws', transportMode: 'direct-wss', token: TOKEN }) });
  const removed = await fetch(`${fixture.baseUrl}/peers/${PEER_ID}`, { method: 'DELETE', headers: owner });
  // Then: removal preserves local and remote outcomes.
  assert.equal(issued.status, 201); assert.equal(enrolled.status, 201); assert.equal(removed.status, 200);
  assert.deepEqual(await removed.json(), { localRemoval: 'removed', peerRevocation: 'unreachable' });
  assert.deepEqual(fixture.calls, ['enroll:direct-wss:wss://peer.example.test/fleet-ws', `remove:${PEER_ID}`]);
});

test('machine redemption rejects browser credentials, consumes once, and rate limits failures', async (context) => {
  // Given: a live redemption route.
  const fixture = await startFixture(); context.after(fixture.close); const body = JSON.stringify({ token: TOKEN, hub: signedIdentity });
  const redeem = (headers: Record<string, string> = { 'content-type': 'application/json' }) => fetch(`${fixture.baseUrl}/pairing/redeem`, { method: 'POST', headers, body });
  // When: browser credentials, one valid call, replay, and brute force arrive.
  const browser = await redeem({ 'content-type': 'application/json', cookie: 'chatmux_auth=browser-secret' });
  const first = await redeem(); const failures = [await redeem()];
  for (let attempt = 0; attempt < 4; attempt += 1) failures.push(await redeem());
  const blocked = await redeem();
  // Then: body-only, one-use, and limiter contracts are visible over HTTP.
  assert.equal(browser.status, 400); assert.equal(first.status, 200);
  assert.deepEqual(failures.map((response) => response.status), [410, 410, 410, 410, 410]);
  assert.equal(blocked.status, 429); assert.match(blocked.headers.get('retry-after') ?? '', /^\d+$/);
});

test('non-owner and malformed enrollment fail before service invocation', async (context) => {
  // Given: a live router.
  const fixture = await startFixture(); context.after(fixture.close);
  // When: a non-owner and malformed owner request enrollment.
  const denied = await fetch(`${fixture.baseUrl}/peers`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const malformed = await fetch(`${fixture.baseUrl}/peers`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-owner': 'yes' }, body: JSON.stringify({ peerUrl: 'wss://peer.example.test/fleet-ws', transportMode: 'direct-wss', token: TOKEN, extra: true }) });
  // Then: both fail closed without side effects.
  assert.equal(denied.status, 403); assert.equal(malformed.status, 400); assert.deepEqual(fixture.calls, []);
});


test('Tailscale owner principal retains its classified owner role', async (context) => {
  // Given: middleware classified an allowlisted Tailscale owner with a local user ID.
  const fixture = await startFixture('tailscale'); context.after(fixture.close);
  // When: the owner requests a pairing token.
  const response = await fetch(`${fixture.baseUrl}/pairing-tokens`, { method: 'POST', headers: { 'x-test-role': 'owner' } });
  // Then: fleet authorization honors the Tailscale role rather than the incidental user ID.
  assert.equal(response.status, 201);
});
