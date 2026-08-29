import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import { FleetHubPairingError } from '@/modules/fleet/services/fleet-hub-pairing.service.js';
import { createFleetPairingTransport } from '@/modules/fleet/settings/fleet-pairing-transport.js';

const hub = {
  descriptor: { installationId: '10000000-0000-4000-8000-000000000001', publicKeyFingerprint: 'SHA256:hub', protocolVersions: ['fleet/1'] as const, capabilities: [] },
  publicKey: 'public-key', signature: 'signature',
};

async function fixture(errorCode = 'TOKEN_EXPIRED') {
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.statusCode = 410;
    response.end(JSON.stringify({ error: errorCode }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new TypeError('transport fixture did not bind');
  return {
    port: address.port,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

test('Given a peer-expired token, when enrollment redeems it, then expiry remains distinct', async (context) => {
  const peer = await fixture(); context.after(peer.close);
  const transport = createFleetPairingTransport();
  await assert.rejects(transport.redeem({ peerUrl: `ws://127.0.0.1:${peer.port}/fleet-ws`, transportMode: 'ssh-loopback', token: 'expired', hub }),
    (error) => error instanceof FleetHubPairingError && error.code === 'PEER_TOKEN_EXPIRED');
});

test('Given an already-used token, when enrollment redeems it, then reuse remains distinct', async (context) => {
  const peer = await fixture('TOKEN_ALREADY_USED'); context.after(peer.close);
  const transport = createFleetPairingTransport();
  await assert.rejects(transport.redeem({ peerUrl: `ws://127.0.0.1:${peer.port}/fleet-ws`, transportMode: 'ssh-loopback', token: 'used', hub }),
    (error) => error instanceof FleetHubPairingError && error.code === 'PEER_TOKEN_ALREADY_USED');
});

test('Given a plaintext listener behind a WSS URL, when enrollment connects, then bad TLS fails closed', async (context) => {
  const peer = await fixture(); context.after(peer.close);
  const transport = createFleetPairingTransport();
  await assert.rejects(transport.redeem({ peerUrl: `wss://127.0.0.1:${peer.port}/fleet-ws`, transportMode: 'direct-wss', token: 'token', hub }),
    (error) => error instanceof FleetHubPairingError && error.code === 'PEER_UNREACHABLE');
});
