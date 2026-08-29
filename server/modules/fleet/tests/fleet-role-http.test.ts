import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import express from 'express';

import { createFleetPairingRouter } from '@/modules/fleet/fleet-pairing.routes.js';
import { FleetHubPairingError } from '@/modules/fleet/services/fleet-hub-pairing.service.js';
import { FleetPairingFailureLimiter } from '@/modules/fleet/services/fleet-pairing-limiter.service.js';
import { FleetPairingError } from '@/modules/fleet/services/fleet-pairing.service.js';

const TOKEN = Buffer.alloc(32, 7).toString('base64url');

test('Given this installation is an active peer, when the owner enrolls another PC, then HTTP returns a typed conflict', async (context) => {
  // Given
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => { Object.defineProperty(request, 'user', { value: { id: 1 } }); next(); });
  app.use('/fleet', createFleetPairingRouter({
    authMode: 'password',
    limiter: new FleetPairingFailureLimiter(),
    pairing: {
      issueToken: () => ({ token: TOKEN, expiresAtMs: 1 }),
      redeem: () => { throw new FleetPairingError('PEER_ROLE_CONFLICT', 'role conflict'); },
      revokeHubGrant: () => true,
    },
    hubPairing: { enroll: async () => { const error = new FleetHubPairingError('PEER_PERSISTENCE_CONFLICT', 'role conflict'); Object.defineProperty(error, 'code', { value: 'HUB_ROLE_CONFLICT' }); throw error; } },
    revocation: { remove: async () => ({ localRemoval: 'not_found', peerRevocation: 'not_attempted' }) },
  }));
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new TypeError('server did not bind');

  // When
  const baseUrl = `http://127.0.0.1:${address.port}/fleet`;
  const response = await fetch(`${baseUrl}/peers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ peerUrl: 'wss://peer.example/fleet-ws', transportMode: 'direct-wss', token: TOKEN }),
  });
  const redemption = await fetch(`${baseUrl}/pairing/redeem`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      token: TOKEN,
      hub: { descriptor: { installationId: '10000000-0000-4000-8000-000000000001', publicKeyFingerprint: 'fingerprint', protocolVersions: ['fleet/1'], capabilities: [] }, publicKey: 'key', signature: 'signature' },
    }),
  });
  const recoveryToken = await fetch(`${baseUrl}/pairing-tokens`, { method: 'POST' });

  // Then
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: 'HUB_ROLE_CONFLICT' });
  assert.equal(redemption.status, 409);
  assert.deepEqual(await redemption.json(), { error: 'PEER_ROLE_CONFLICT' });
  assert.equal(recoveryToken.status, 201);
});
