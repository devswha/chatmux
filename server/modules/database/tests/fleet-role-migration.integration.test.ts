import assert from 'node:assert/strict';
import test from 'node:test';

import Database from 'better-sqlite3';

import { runMigrations } from '@/modules/database/migrations.js';

const NOW = 1_800_000_000_000;

function legacyConflictDatabase(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE fleet_peers (
      peer_id TEXT PRIMARY KEY, url TEXT, transport_mode TEXT, display_label TEXT,
      pinned_public_key TEXT, pinned_public_key_fingerprint TEXT, enrollment_state TEXT,
      negotiated_protocol TEXT, negotiated_capabilities_json TEXT, connection_generation INTEGER,
      created_at_ms INTEGER, updated_at_ms INTEGER, last_seen_at_ms INTEGER, revoked_at_ms INTEGER
    );
    CREATE TABLE fleet_hub_grants (
      grant_id INTEGER PRIMARY KEY, peer_id TEXT, hub_installation_id TEXT, pinned_public_key TEXT,
      pinned_public_key_fingerprint TEXT, grant_state TEXT, created_at_ms INTEGER,
      updated_at_ms INTEGER, revoked_at_ms INTEGER
    );
    CREATE TABLE fleet_pairing_tokens (
      token_hash TEXT PRIMARY KEY, created_at_ms INTEGER, expires_at_ms INTEGER, consumed_at_ms INTEGER
    );
    INSERT INTO fleet_peers VALUES (
      'remote', 'wss://remote.example/fleet-ws', 'direct-wss', 'remote', 'peer-key',
      'peer-fingerprint', 'enrolled', NULL, '[]', 0, ${NOW}, ${NOW}, NULL, NULL
    );
    INSERT INTO fleet_hub_grants VALUES (
      1, 'local', 'hub', 'hub-key', 'hub-fingerprint', 'active', ${NOW}, ${NOW}, NULL
    );
  `);
  for (let version = 1; version <= 18; version += 1) {
    db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(version);
  }
  return db;
}

test('Given legacy data with both active roles, when migration reconciles it, then startup fails closed actionably', () => {
  // Given
  const db = legacyConflictDatabase();

  // When / Then
  assert.throws(
    () => runMigrations(db),
    (error) => error instanceof Error
      && error.name === 'FleetRoleConflictDataError'
      && 'code' in error && error.code === 'FLEET_ROLE_CONFLICT'
      && /revoke the inbound hub grant or remove all outbound peers/i.test(error.message),
  );
  assert.equal(db.prepare<[], Readonly<{ version: number }>>('SELECT version FROM schema_migrations WHERE version = 19').get(), undefined);
  db.close();
});
