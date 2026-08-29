import assert from 'node:assert/strict';
import test from 'node:test';

import Database from 'better-sqlite3';

import { runMigrations } from '@/modules/database/migrations.js';
import { FleetPeersRepository } from '@/modules/database/repositories/fleet-peers.js';
import { INIT_SCHEMA_SQL } from '@/modules/database/schema.js';

const NOW = 1_800_000_000_000;
const enrollment = {
  peerId: '00000000-0000-4000-8000-000000000001',
  url: 'wss://peer.example.test/fleet-ws',
  transportMode: 'direct-wss' as const,
  displayLabel: 'Peer',
  pinnedPublicKey: 'public-key',
  pinnedPublicKeyFingerprint: 'SHA256:fingerprint',
};

test('Given an enrolled peer, when local removal runs, then revocation must precede forgetting', () => {
  // Given: one enrolled peer in a real migrated SQLite database.
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON'); db.exec(INIT_SCHEMA_SQL); runMigrations(db);
  const peers = new FleetPeersRepository(db);
  assert.equal(peers.enroll(enrollment, NOW).ok, true);

  // When: removal is attempted before and after explicit revocation.
  const active = peers.removeRevoked(enrollment.peerId);
  peers.revoke(enrollment.peerId, NOW + 1);
  const removed = peers.removeRevoked(enrollment.peerId);
  const replacement = peers.enroll(enrollment, NOW + 2);

  // Then: active trust is protected and revoked metadata can be replaced cleanly.
  assert.equal(active, 'peer_active');
  assert.equal(removed, 'removed');
  assert.equal(replacement.ok, true);
  db.close();
});
