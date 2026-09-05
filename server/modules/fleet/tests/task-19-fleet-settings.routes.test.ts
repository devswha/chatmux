import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import express from 'express';

import { createFleetSettingsRouter } from '@/modules/fleet/settings/fleet-settings.routes.js';

const PEER_ID = '00000000-0000-4000-8000-000000000001';

async function fixture() {
  const calls: string[] = [];
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => {
    Object.defineProperty(request, 'user', { value: request.headers['x-role'] === 'user'
      ? { id: 2, tailscaleRole: 'user' }
      : { id: 1, tailscaleRole: 'owner' } });
    next();
  });
  app.use('/fleet', createFleetSettingsRouter({
    authMode: 'tailscale',
    identity: async () => ({ installationId: '10000000-0000-4000-8000-000000000001', publicKeyFingerprint: 'SHA256:public-fingerprint' }),
    peers: () => [{
      peerId: PEER_ID, displayLabel: 'Workstation', transportMode: 'direct-wss', enrollmentState: 'enrolled',
      negotiatedProtocol: 'fleet/1', negotiatedCapabilities: ['catalog.read'], lastSeenAtMs: 1_800_000_000_000,
      url: 'wss://secret-host.example/fleet-ws', pinnedPublicKey: 'PRIVATE', pinnedPublicKeyFingerprint: 'SHA256:peer',
    }],
    role: () => 'hub',
    statuses: () => [{ peerId: PEER_ID, state: 'offline', protocolVersion: 'fleet/1', capabilities: ['catalog.read'], peerProcessEpoch: null, generation: null, lastHeartbeatAtMs: null }],
    reconnect: (peerId) => { calls.push(`reconnect:${peerId}`); return true; },
    forget: (peerId) => { calls.push(`forget:${peerId}`); return 'removed'; },
    sshCandidates: async () => ({ available: true, defaultUser: 'alice', candidates: [{ hostName: 'lab', address: '100.64.0.2', os: 'linux', online: true, supported: true }] }),
  }));
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new TypeError('fixture did not bind');
  return {
    baseUrl: `http://127.0.0.1:${address.port}/fleet`, calls,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

test('Given an owner, when fleet settings load, then only public operational metadata is returned', async (context) => {
  const subject = await fixture(); context.after(subject.close);
  const response = await fetch(`${subject.baseUrl}/settings`, { headers: { 'x-role': 'owner' } });
  assert.equal(response.status, 200);
  const body: unknown = await response.json();
  assert.equal(typeof body, 'object');
  const serialized = JSON.stringify(body);
  assert.match(serialized, /SHA256:public-fingerprint/);
  assert.match(serialized, /"role":"hub"/);
  assert.match(serialized, /"state":"offline"/);
  assert.match(serialized, /Workstation/);
  assert.doesNotMatch(serialized, /secret-host|PRIVATE|tokenHash|pinnedPublicKey/);
});

test('Given a non-owner, when fleet settings and actions are requested, then inventory remains undisclosed', async (context) => {
  const subject = await fixture(); context.after(subject.close);
  const headers = { 'x-role': 'user' };
  const [settings, reconnect, remove] = await Promise.all([
    fetch(`${subject.baseUrl}/settings`, { headers }),
    fetch(`${subject.baseUrl}/peers/${PEER_ID}/reconnect`, { method: 'POST', headers }),
    fetch(`${subject.baseUrl}/peers/${PEER_ID}/local`, { method: 'DELETE', headers }),
  ]);
  assert.deepEqual([settings.status, reconnect.status, remove.status], [403, 403, 403]);
  assert.deepEqual(subject.calls, []);
});

test('Given tailnet SSH candidates, when requested, then only the owner receives the pre-fill list', async (context) => {
  const subject = await fixture(); context.after(subject.close);
  const [owner, user] = await Promise.all([
    fetch(`${subject.baseUrl}/ssh-candidates`, { headers: { 'x-role': 'owner' } }),
    fetch(`${subject.baseUrl}/ssh-candidates`, { headers: { 'x-role': 'user' } }),
  ]);
  assert.equal(user.status, 403);
  assert.equal(owner.status, 200);
  assert.equal(owner.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await owner.json(), { available: true, defaultUser: 'alice', candidates: [{ hostName: 'lab', address: '100.64.0.2', os: 'linux', online: true, supported: true }] });
});

test('Given an offline enrolled peer, when the owner reconnects then removes it locally, outcomes stay distinct', async (context) => {
  const subject = await fixture(); context.after(subject.close);
  const headers = { 'x-role': 'owner' };
  const reconnect = await fetch(`${subject.baseUrl}/peers/${PEER_ID}/reconnect`, { method: 'POST', headers });
  const remove = await fetch(`${subject.baseUrl}/peers/${PEER_ID}/local`, { method: 'DELETE', headers });
  assert.deepEqual(await reconnect.json(), { accepted: true });
  assert.deepEqual(await remove.json(), { hubLocalRemoval: 'removed' });
  assert.deepEqual(subject.calls, [`reconnect:${PEER_ID}`, `forget:${PEER_ID}`]);
});
