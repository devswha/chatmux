import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import Database from 'better-sqlite3';

import { FLEET_PERSISTENCE_SCHEMA_SQL, FleetPairingTokenInputError } from '@/modules/database/index.js';
import { SqliteFleetPairingStore } from '@/modules/fleet/services/fleet-pairing-store.service.js';

const NOW = 1_800_000_000_000;
const PEER_ID = '00000000-0000-4000-8000-000000000001';
const TOKEN = Uint8Array.from({ length: 32 }, (_, index) => index);
const grant = { peerId: PEER_ID, hubInstallationId: '10000000-0000-4000-8000-000000000001', pinnedPublicKey: 'hub-public-key', pinnedPublicKeyFingerprint: 'hub-fingerprint', revokedAtMs: null };

function fixture(): Readonly<{ db: Database.Database; store: SqliteFleetPairingStore }> {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE fleet_peers (
    peer_id TEXT PRIMARY KEY, enrollment_state TEXT NOT NULL
  );
  CREATE TABLE fleet_pairing_tokens (
    token_hash TEXT PRIMARY KEY, created_at_ms INTEGER NOT NULL,
    expires_at_ms INTEGER NOT NULL, consumed_at_ms INTEGER
  );
  CREATE TABLE fleet_hub_grants (
    grant_id INTEGER PRIMARY KEY AUTOINCREMENT, peer_id TEXT NOT NULL,
    hub_installation_id TEXT NOT NULL, pinned_public_key TEXT NOT NULL,
    pinned_public_key_fingerprint TEXT NOT NULL,
    grant_state TEXT NOT NULL DEFAULT 'active', created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL, revoked_at_ms INTEGER
  );
  CREATE UNIQUE INDEX one_active_grant ON fleet_hub_grants(peer_id)
    WHERE grant_state = 'active';`);
  return { db, store: new SqliteFleetPairingStore(db) };
}

test('peer redemption pins a hub grant on the production schema without registry rows', () => {
  // Given: the production fleet schema with enforced foreign keys and an empty peer registry.
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(FLEET_PERSISTENCE_SCHEMA_SQL);
  const store = new SqliteFleetPairingStore(db);
  store.issue(TOKEN, NOW + 600_000, NOW);
  // When: a hub redeems the token on a peer whose local peer registry has no rows.
  const result = store.consumeAndPin(TOKEN, grant, NOW + 1);
  // Then: the grant pins and every foreign key remains valid.
  assert.deepEqual(result, { kind: 'enrolled' });
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  db.close();
});

test('atomically consumes a hash-only token and pins one active hub', () => {
  // Given: one persisted pairing token.
  const { db, store } = fixture(); store.issue(TOKEN, NOW + 600_000, NOW);
  // When: the same token attempts to pin the hub twice.
  const first = store.consumeAndPin(TOKEN, grant, NOW + 1);
  const second = store.consumeAndPin(TOKEN, grant, NOW + 2);
  // Then: one grant exists, plaintext is absent, and replay is explicit.
  assert.deepEqual(first, { kind: 'enrolled' }); assert.deepEqual(second, { kind: 'already_consumed' });
  const row: unknown = db.prepare('SELECT token_hash FROM fleet_pairing_tokens').get();
  assert.deepEqual(row, { token_hash: createHash('sha256').update(TOKEN).digest('hex') });
  const active = db.prepare<[], Readonly<{ count: number }>>("SELECT COUNT(*) AS count FROM fleet_hub_grants WHERE grant_state = 'active'").get();
  assert.deepEqual(active, { count: 1 }); db.close();
});

test('active replacement rejection leaves the new token usable after revoke', () => {
  // Given: one active grant and a fresh replacement token.
  const { db, store } = fixture(); const replacement = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
  store.issue(TOKEN, NOW + 600_000, NOW); store.consumeAndPin(TOKEN, grant, NOW + 1); store.issue(replacement, NOW + 600_000, NOW + 2);
  // When: replacement is attempted before and after explicit revoke.
  const blocked = store.consumeAndPin(replacement, grant, NOW + 3); store.revoke(PEER_ID, NOW + 4); const enrolled = store.consumeAndPin(replacement, grant, NOW + 5);
  // Then: the blocked attempt does not burn the token.
  assert.deepEqual(blocked, { kind: 'active_grant_exists' }); assert.deepEqual(enrolled, { kind: 'enrolled' }); db.close();
});

test('maps repository token outcomes without parallel token persistence', () => {
  // Given: the production store source and one expired token.
  const source = readFileSync(new URL('../services/fleet-pairing-store.service.ts', import.meta.url), 'utf8');
  const { db, store } = fixture();
  store.issue(TOKEN, NOW + 1, NOW);

  // When: missing, expired, and consumed tokens are redeemed.
  const missing = store.consumeAndPin(Uint8Array.from({ length: 32 }, () => 255), grant, NOW);
  const expired = store.consumeAndPin(TOKEN, grant, NOW + 1);
  const enrolled = store.consumeAndPin(TOKEN, grant, NOW);
  const replayed = store.consumeAndPin(TOKEN, grant, NOW);

  // Then: repository outcomes are preserved and the store owns no token SQL or hashing.
  assert.deepEqual([missing.kind, expired.kind, enrolled.kind, replayed.kind], [
    'not_found', 'expired', 'enrolled', 'already_consumed',
  ]);
  assert.doesNotMatch(source, /fleet_pairing_tokens|createHash/);
  assert.throws(() => store.issue(Uint8Array.of(1), NOW + 2, NOW), FleetPairingTokenInputError);
  db.close();
});

test('rolls back token consumption when grant pinning fails', () => {
  // Given: a valid token and a database trigger that rejects grant insertion.
  const { db, store } = fixture();
  store.issue(TOKEN, NOW + 600_000, NOW);
  db.exec(`CREATE TRIGGER reject_grant_pin BEFORE INSERT ON fleet_hub_grants
    BEGIN SELECT RAISE(ABORT, 'grant pin rejected'); END;`);

  // When: redemption reaches the grant insertion.
  assert.throws(() => store.consumeAndPin(TOKEN, grant, NOW + 1), /grant pin rejected/);
  db.exec('DROP TRIGGER reject_grant_pin');
  const retried = store.consumeAndPin(TOKEN, grant, NOW + 2);

  // Then: the outer transaction preserved the token for a successful retry.
  assert.deepEqual(retried, { kind: 'enrolled' });
  db.close();
});
