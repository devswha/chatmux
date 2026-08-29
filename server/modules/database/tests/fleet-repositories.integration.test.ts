import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { runMigrations } from '@/modules/database/migrations.js';
import { FleetHubGrantDataError, FleetHubGrantsRepository } from '@/modules/database/repositories/fleet-hub-grants.js';
import { FleetPeerDataError, FleetPeersRepository } from '@/modules/database/repositories/fleet-peers.js';
import { INIT_SCHEMA_SQL } from '@/modules/database/schema.js';

const NOW = 1_800_000_000_000;

function openFleetDatabase(filename = ':memory:'): Database.Database {
  const db = new Database(filename);
  db.pragma('foreign_keys = ON');
  db.exec(INIT_SCHEMA_SQL);
  runMigrations(db);
  return db;
}

function enrollment(index: number) {
  return {
    peerId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    url: `wss://peer-${index}.example.test/fleet-ws`,
    transportMode: 'direct-wss' as const,
    displayLabel: `Peer ${index}`,
    pinnedPublicKey: `public-key-${index}`,
    pinnedPublicKeyFingerprint: `fingerprint-${index}`,
  };
}

test('enforces nine enrolled peers and reports duplicate identity metadata', () => {
  // Given: a fleet repository with one enrolled peer.
  const db = openFleetDatabase();
  const peers = new FleetPeersRepository(db);
  const first = peers.enroll(enrollment(1), NOW);
  assert.equal(first.ok, true);

  // When: duplicate metadata and then capacity-overflow enrollments are attempted.
  assert.deepEqual(peers.enroll(enrollment(1), NOW + 1), { ok: false, reason: 'duplicate_peer_id' });
  assert.deepEqual(
    peers.enroll({ ...enrollment(2), url: enrollment(1).url }, NOW + 1),
    { ok: false, reason: 'duplicate_url' },
  );
  assert.deepEqual(
    peers.enroll({ ...enrollment(2), pinnedPublicKey: enrollment(1).pinnedPublicKey }, NOW + 1),
    { ok: false, reason: 'duplicate_public_key' },
  );
  assert.deepEqual(
    peers.enroll({
      ...enrollment(2),
      pinnedPublicKeyFingerprint: enrollment(1).pinnedPublicKeyFingerprint,
    }, NOW + 1),
    { ok: false, reason: 'duplicate_fingerprint' },
  );
  for (let index = 2; index <= 9; index += 1) peers.enroll(enrollment(index), NOW + index);
  const tenth = peers.enroll(enrollment(10), NOW + 10);

  // Then: both the repository and database reject a tenth enrolled peer.
  assert.deepEqual(tenth, { ok: false, reason: 'capacity' });
  assert.throws(() => db.prepare(`INSERT INTO fleet_peers (
    peer_id, url, transport_mode, display_label, pinned_public_key,
    pinned_public_key_fingerprint, created_at_ms, updated_at_ms
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    enrollment(10).peerId,
    enrollment(10).url,
    enrollment(10).transportMode,
    enrollment(10).displayLabel,
    enrollment(10).pinnedPublicKey,
    enrollment(10).pinnedPublicKeyFingerprint,
    NOW + 10,
    NOW + 10,
  ));
  assert.equal(peers.list().filter((peer) => peer.enrollmentState === 'enrolled').length, 9);
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  db.close();
});

test('persists negotiation generation across restart and permits explicit revoke then re-enroll', () => {
  // Given: an enrolled peer in a file-backed database.
  const directory = mkdtempSync(join(tmpdir(), 'chatmux-fleet-peer-'));
  const filename = join(directory, 'fleet.sqlite');
  let db = openFleetDatabase(filename);
  let peers = new FleetPeersRepository(db);
  peers.enroll(enrollment(1), NOW);

  try {
    // When: negotiation is recorded, the peer is revoked, re-enrolled, and the DB restarted.
    peers.recordNegotiation({
      peerId: enrollment(1).peerId,
      protocol: 'fleet/1',
      capabilities: ['catalog.read', 'session.read'],
      connectionGeneration: 7,
      lastSeenAtMs: NOW + 20,
      updatedAtMs: NOW + 20,
    });
    db.close();
    db = new Database(filename);
    db.pragma('foreign_keys = ON');
    peers = new FleetPeersRepository(db);
    assert.equal(peers.find(enrollment(1).peerId)?.connectionGeneration, 7);
    assert.deepEqual(peers.find(enrollment(1).peerId)?.negotiatedCapabilities, [
      'catalog.read',
      'session.read',
    ]);
    peers.revoke(enrollment(1).peerId, NOW + 30);
    const reenrolled = peers.enroll({ ...enrollment(1), displayLabel: 'Peer one again' }, NOW + 40);
    db.close();
    db = new Database(filename);
    db.pragma('foreign_keys = ON');
    peers = new FleetPeersRepository(db);

    // Then: re-enrollment survives restart with reset connection negotiation state.
    assert.equal(reenrolled.ok, true);
    assert.deepEqual(peers.find(enrollment(1).peerId), {
      ...enrollment(1),
      displayLabel: 'Peer one again',
      enrollmentState: 'enrolled',
      negotiatedProtocol: null,
      negotiatedCapabilities: [],
      connectionGeneration: 0,
      createdAtMs: NOW,
      updatedAtMs: NOW + 40,
      lastSeenAtMs: null,
      revokedAtMs: null,
    });
  } finally {
    if (db.open) db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('allows only one active inbound hub grant and preserves revoked history', () => {
  // Given: a standalone installation and its first active inbound hub grant.
  const db = openFleetDatabase();
  const grants = new FleetHubGrantsRepository(db);
  const grant = {
    peerId: enrollment(1).peerId,
    hubInstallationId: '10000000-0000-4000-8000-000000000001',
    pinnedPublicKey: 'hub-public-key',
    pinnedPublicKeyFingerprint: 'hub-fingerprint',
  };
  assert.equal(grants.create(grant, NOW).ok, true);

  // When: a duplicate active grant is rejected, then revoked and replaced.
  assert.deepEqual(grants.create(grant, NOW + 1), { ok: false, reason: 'active_grant_exists' });
  assert.throws(() => db.prepare(`INSERT INTO fleet_hub_grants (
    peer_id, hub_installation_id, pinned_public_key, pinned_public_key_fingerprint,
    created_at_ms, updated_at_ms
  ) VALUES (?, ?, ?, ?, ?, ?)`).run(
    grant.peerId,
    'another-hub',
    'another-hub-key',
    'another-hub-fingerprint',
    NOW + 1,
    NOW + 1,
  ));
  grants.revokeActive(enrollment(1).peerId, NOW + 2);
  const replacement = grants.create(grant, NOW + 4);

  // Then: one active and one revoked grant remain, with valid foreign keys.
  assert.equal(replacement.ok, true);
  assert.deepEqual(grants.listForPeer(enrollment(1).peerId).map(({ grantState }) => grantState), [
    'revoked',
    'active',
  ]);
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  db.close();
});

test('rejects malformed persisted peer capabilities at the repository boundary', () => {
  // Given: a constraint-bypassed malformed row simulating disk corruption.
  const db = openFleetDatabase();
  db.pragma('ignore_check_constraints = ON');
  db.prepare(`INSERT INTO fleet_peers (
    peer_id, url, transport_mode, display_label, pinned_public_key,
    pinned_public_key_fingerprint, negotiated_capabilities_json, created_at_ms, updated_at_ms
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    enrollment(1).peerId,
    enrollment(1).url,
    enrollment(1).transportMode,
    enrollment(1).displayLabel,
    enrollment(1).pinnedPublicKey,
    enrollment(1).pinnedPublicKeyFingerprint,
    '["not-a-capability"]',
    NOW,
    NOW,
  );
  db.pragma('ignore_check_constraints = OFF');

  // When/Then: reading the malformed row fails closed with a typed data error.
  assert.throws(() => new FleetPeersRepository(db).find(enrollment(1).peerId), FleetPeerDataError);
  db.close();
});


test('rejects malformed persisted hub grants at the repository boundary', () => {
  // Given: an invalid grant state inserted while constraints are bypassed.
  const db = openFleetDatabase();
  new FleetPeersRepository(db).enroll(enrollment(1), NOW);
  db.pragma('ignore_check_constraints = ON');
  db.prepare(`INSERT INTO fleet_hub_grants (
    peer_id, hub_installation_id, pinned_public_key, pinned_public_key_fingerprint,
    grant_state, created_at_ms, updated_at_ms
  ) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    enrollment(1).peerId,
    'hub-id',
    'hub-key',
    'hub-fingerprint',
    'corrupt',
    NOW,
    NOW,
  );
  db.pragma('ignore_check_constraints = OFF');

  // When/Then: reading cannot turn the malformed row into a trusted grant.
  assert.throws(
    () => new FleetHubGrantsRepository(db).listForPeer(enrollment(1).peerId),
    FleetHubGrantDataError,
  );
  db.close();
});

