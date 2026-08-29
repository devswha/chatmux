import assert from 'node:assert/strict';
import { createHash, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import test from 'node:test';

import Database from 'better-sqlite3';

import { FLEET_PERSISTENCE_SCHEMA_SQL } from '@/modules/database/index.js';
import { FleetHubPairingError, FleetHubPairingService } from '@/modules/fleet/services/fleet-hub-pairing.service.js';
import { canonicalPairingIdentity, type SignedInstallationIdentity } from '@/modules/fleet/services/fleet-pairing.service.js';
import { SqliteFleetPairingStore } from '@/modules/fleet/services/fleet-pairing-store.service.js';

import { FLEET_CAPABILITIES, FLEET_PROTOCOL_VERSIONS, type FleetInstallationDescriptor } from '../../../../shared/fleet.js';

const NOW = 1_800_000_000_000;
const HUB_ID = '10000000-0000-4000-8000-000000000001';
const PEER_ID = '00000000-0000-4000-8000-000000000001';
const TOKEN = Uint8Array.from({ length: 32 }, (_, index) => index);

function identity(installationId: string): SignedInstallationIdentity {
  const keys = generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const der = createPublicKey(keys.publicKey).export({ type: 'spki', format: 'der' });
  const descriptor: FleetInstallationDescriptor = {
    installationId,
    publicKeyFingerprint: `SHA256:${createHash('sha256').update(der).digest('base64url')}`,
    protocolVersions: FLEET_PROTOCOL_VERSIONS,
    capabilities: FLEET_CAPABILITIES,
  };
  return {
    descriptor,
    publicKey: keys.publicKey,
    signature: sign(null, canonicalPairingIdentity(descriptor, keys.publicKey), keys.privateKey).toString('base64url'),
  };
}

function enrollmentRow(db: Database.Database): void {
  db.prepare(`INSERT INTO fleet_peers (
    peer_id, url, transport_mode, display_label, pinned_public_key,
    pinned_public_key_fingerprint, created_at_ms, updated_at_ms
  ) VALUES (?, ?, 'direct-wss', 'nested peer', 'peer-key', 'peer-fingerprint', ?, ?)`).run(
    PEER_ID, 'wss://peer.example.test/fleet-ws', NOW, NOW,
  );
}

test('Given an active inbound hub grant, when outbound enrollment starts, then no remote or persistence side effect occurs', async () => {
  // Given
  let transportCalls = 0;
  let persistenceCalls = 0;
  const service = new FleetHubPairingService({
    identity: identity(HUB_ID),
    activeInboundGrant: () => true,
    transport: { redeem: async () => { transportCalls += 1; return identity(PEER_ID); } },
    peers: {
      find: () => undefined,
      list: () => [],
      enroll: (enrollment) => { persistenceCalls += 1; return { ok: true, peer: enrollment }; },
    },
  });

  // When / Then
  await assert.rejects(
    service.enroll({ peerUrl: 'wss://peer.example.test/fleet-ws', transportMode: 'direct-wss', token: 'secret' }),
    (error) => error instanceof FleetHubPairingError && error.code === 'HUB_ROLE_CONFLICT',
  );
  assert.deepEqual({ transportCalls, persistenceCalls }, { transportCalls: 0, persistenceCalls: 0 });
});

test('Given an enrolled outbound peer, when inbound redemption starts, then the token and grant remain untouched', () => {
  // Given
  const db = new Database(':memory:');
  db.exec(FLEET_PERSISTENCE_SCHEMA_SQL);
  const store = new SqliteFleetPairingStore(db);
  store.issue(TOKEN, NOW + 600_000, NOW);
  enrollmentRow(db);

  // When
  const result = store.consumeAndPin(TOKEN, {
    peerId: HUB_ID,
    hubInstallationId: PEER_ID,
    pinnedPublicKey: 'hub-key',
    pinnedPublicKeyFingerprint: 'hub-fingerprint',
    revokedAtMs: null,
  }, NOW + 1);

  // Then
  assert.deepEqual(result, { kind: 'role_conflict' });
  assert.deepEqual(
    db.prepare('SELECT consumed_at_ms FROM fleet_pairing_tokens').get(),
    { consumed_at_ms: null },
  );
  assert.equal(db.prepare<[], Readonly<{ count: number }>>('SELECT COUNT(*) AS count FROM fleet_hub_grants').get()?.count, 0);
  db.prepare("UPDATE fleet_peers SET enrollment_state = 'revoked', revoked_at_ms = ? WHERE peer_id = ?")
    .run(NOW + 2, PEER_ID);
  assert.deepEqual(store.consumeAndPin(TOKEN, {
    peerId: HUB_ID,
    hubInstallationId: PEER_ID,
    pinnedPublicKey: 'hub-key',
    pinnedPublicKeyFingerprint: 'hub-fingerprint',
    revokedAtMs: null,
  }, NOW + 3), { kind: 'enrolled' });
  db.close();
});

test('Given A controls B, when B enrolls C or cycles back to A, then both attempts have zero effects', async () => {
  // Given
  const attemptedTargets: string[] = [];
  const service = new FleetHubPairingService({
    identity: identity(PEER_ID),
    activeInboundGrant: () => true,
    transport: { redeem: async (request) => { attemptedTargets.push(request.peerUrl); return identity(HUB_ID); } },
    peers: { find: () => undefined, list: () => [], enroll: (enrollment) => ({ ok: true, peer: enrollment }) },
  });

  // When
  const results = await Promise.allSettled([
    service.enroll({ peerUrl: 'wss://c.example.test/fleet-ws', transportMode: 'direct-wss', token: 'nested' }),
    service.enroll({ peerUrl: 'wss://a.example.test/fleet-ws', transportMode: 'direct-wss', token: 'cycle' }),
  ]);

  // Then
  assert.ok(results.every((result) => result.status === 'rejected'
    && result.reason instanceof FleetHubPairingError && result.reason.code === 'HUB_ROLE_CONFLICT'));
  assert.deepEqual(attemptedTargets, []);
});
