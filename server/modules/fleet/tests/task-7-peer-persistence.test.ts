import assert from 'node:assert/strict';
import test from 'node:test';

import Database from 'better-sqlite3';

import {
  SqliteFleetGenerationStore,
  SqliteFleetPeerTrustStore,
} from '../peer/persistence.js';

const PEER_ID = '123e4567-e89b-42d3-a456-426614174000';
const HUB_ID = '223e4567-e89b-42d3-a456-426614174000';

function database(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE fleet_hub_grants (
    grant_id INTEGER PRIMARY KEY, peer_id TEXT NOT NULL, hub_installation_id TEXT NOT NULL,
    pinned_public_key TEXT NOT NULL, grant_state TEXT NOT NULL
  );
  CREATE TABLE app_config (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  return db;
}

test('Given persisted owner grants, when trust is looked up, then only the exact hub grant state and key are returned', async () => {
  const db = database();
  const trust = new SqliteFleetPeerTrustStore(db, PEER_ID);
  db.prepare('INSERT INTO fleet_hub_grants VALUES (1, ?, ?, ?, ?)')
    .run(PEER_ID, HUB_ID, 'active-public-key', 'active');

  const active = await trust.find(HUB_ID);
  db.prepare('UPDATE fleet_hub_grants SET grant_state = ? WHERE grant_id = 1').run('revoked');
  const revoked = await trust.find(HUB_ID);
  const absent = await trust.find('323e4567-e89b-42d3-a456-426614174000');

  assert.deepEqual(active, {
    installationId: HUB_ID, pinnedPublicKey: 'active-public-key', state: 'active',
  });
  assert.equal(revoked?.state, 'revoked');
  assert.equal(absent, undefined);
  db.close();
});

test('Given the local peer generation row, when connections authenticate, then generations increase atomically', async () => {
  const db = database();
  const generations = new SqliteFleetGenerationStore(db, PEER_ID);

  const first = await generations.claimNext();
  const second = await generations.claimNext();

  assert.deepEqual([first, second], [1, 2]);
  db.close();
});
