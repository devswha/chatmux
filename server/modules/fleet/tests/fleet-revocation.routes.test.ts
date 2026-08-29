import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import express from 'express';

import { createFleetPairingRouter } from '@/modules/fleet/fleet-pairing.routes.js';
import { FleetPairingFailureLimiter } from '@/modules/fleet/services/fleet-pairing-limiter.service.js';
import { FleetRevocationService } from '@/modules/fleet/services/fleet-revocation.service.js';

const PEER_ID = '00000000-0000-4000-8000-000000000001';
const peer = { peerId: PEER_ID, url: 'wss://peer.example.test/fleet-ws', transportMode: 'direct-wss' as const, enrollmentState: 'enrolled' as const };
const revokedPeer = { ...peer, enrollmentState: 'revoked' as const };
const identity = { descriptor: { installationId: '10000000-0000-4000-8000-000000000001', publicKeyFingerprint: 'fingerprint', protocolVersions: ['fleet/1'] as const, capabilities: [] }, publicKey: 'public-key', signature: 'signature' };

function signal<T>(): Readonly<{ promise: Promise<T>; resolve: (value: T) => void }> {
  let resolvePromise: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => { resolvePromise = resolve; });
  return { promise, resolve: resolvePromise };
}

test('DELETE denies local peer admission before its remote response completes', async (context) => {
  // Given: a live owner route, an enrolled peer, and a held remote revoke.
  let localPeer: typeof peer | typeof revokedPeer = peer;
  const started = signal<void>(); const release = signal<boolean>();
  const revocation = new FleetRevocationService({ identity,
    peers: { find: () => localPeer, revoke: () => { localPeer = revokedPeer; return localPeer; } },
    transport: { revoke: async () => { started.resolve(); return release.promise; } },
  });
  const app = express(); app.use(express.json());
  app.use((request, _response, next) => { Object.defineProperty(request, 'user', { value: { id: 1 } }); next(); });
  app.use('/fleet', createFleetPairingRouter({ authMode: 'password', limiter: new FleetPairingFailureLimiter(),
    pairing: { issueToken: () => ({ token: '', expiresAtMs: 0 }), redeem: () => identity, revokeHubGrant: () => false },
    hubPairing: { enroll: async () => ({ peerId: PEER_ID }) }, revocation,
  }));
  const server = createServer(app); context.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (address === null || typeof address === 'string') throw new TypeError('test server did not bind TCP');
  // When: DELETE reaches the held remote transport.
  const responsePromise = fetch(`http://127.0.0.1:${address.port}/fleet/peers/${PEER_ID}`, { method: 'DELETE' });
  await started.promise;
  // Then: local admission is denied before the HTTP response can finish.
  try {
    assert.equal(localPeer.enrollmentState, 'revoked');
  } finally {
    release.resolve(false);
  }
  const response = await responsePromise;
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { localRemoval: 'removed', peerRevocation: 'refused' });
});
