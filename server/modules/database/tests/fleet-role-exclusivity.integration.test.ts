import assert from 'node:assert/strict';
import test from 'node:test';

import Database from 'better-sqlite3';

import { FLEET_PERSISTENCE_SCHEMA_SQL } from '@/modules/database/index.js';

const NOW = 1_800_000_000_000;

function database(): Database.Database {
  const db = new Database(':memory:');
  db.exec(FLEET_PERSISTENCE_SCHEMA_SQL);
  return db;
}

function insertPeer(db: Database.Database, state: 'enrolled' | 'revoked' = 'enrolled'): void {
  db.prepare(`INSERT INTO fleet_peers (
    peer_id, url, transport_mode, display_label, pinned_public_key,
    pinned_public_key_fingerprint, enrollment_state, created_at_ms, updated_at_ms, revoked_at_ms
  ) VALUES ('peer', 'wss://peer.example/fleet-ws', 'direct-wss', 'peer', 'peer-key',
    'peer-fingerprint', ?, ?, ?, ?)`).run(state, NOW, NOW, state === 'revoked' ? NOW : null);
}

function insertGrant(db: Database.Database, state: 'active' | 'revoked' = 'active'): void {
  db.prepare(`INSERT INTO fleet_hub_grants (
    peer_id, hub_installation_id, pinned_public_key, pinned_public_key_fingerprint,
    grant_state, created_at_ms, updated_at_ms, revoked_at_ms
  ) VALUES ('local', 'hub', 'hub-key', 'hub-fingerprint', ?, ?, ?, ?)`).run(
    state, NOW, NOW, state === 'revoked' ? NOW : null,
  );
}

test('Given an active inbound grant, when an enrolled peer is inserted or reactivated, then SQLite aborts both writes', () => {
  // Given
  const db = database();
  insertGrant(db);
  insertPeer(db, 'revoked');

  // When / Then
  assert.throws(() => insertPeer(db), /fleet role conflict/);
  assert.throws(
    () => db.prepare("UPDATE fleet_peers SET enrollment_state = 'enrolled', revoked_at_ms = NULL WHERE peer_id = 'peer'").run(),
    /fleet role conflict/,
  );
  db.close();
});

test('Given an enrolled outbound peer, when an active grant is inserted or reactivated, then SQLite aborts both writes', () => {
  // Given
  const db = database();
  insertPeer(db);
  insertGrant(db, 'revoked');

  // When / Then
  assert.throws(() => insertGrant(db), /fleet role conflict/);
  assert.throws(
    () => db.prepare("UPDATE fleet_hub_grants SET grant_state = 'active', revoked_at_ms = NULL WHERE grant_id = 1").run(),
    /fleet role conflict/,
  );
  db.close();
});

test('Given either active role is explicitly revoked, when the opposite role is inserted, then transition succeeds', () => {
  // Given
  const peerTransition = database();
  insertGrant(peerTransition);
  peerTransition.prepare("UPDATE fleet_hub_grants SET grant_state = 'revoked', revoked_at_ms = ?").run(NOW + 1);
  const hubTransition = database();
  insertPeer(hubTransition);
  hubTransition.prepare("UPDATE fleet_peers SET enrollment_state = 'revoked', revoked_at_ms = ?").run(NOW + 1);

  // When
  insertPeer(peerTransition);
  insertGrant(hubTransition);

  // Then
  assert.equal(peerTransition.prepare<[], Readonly<{ count: number }>>("SELECT COUNT(*) AS count FROM fleet_peers WHERE enrollment_state = 'enrolled'").get()?.count, 1);
  assert.equal(hubTransition.prepare<[], Readonly<{ count: number }>>("SELECT COUNT(*) AS count FROM fleet_hub_grants WHERE grant_state = 'active'").get()?.count, 1);
  peerTransition.close();
  hubTransition.close();
});
