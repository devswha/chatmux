import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { runMigrations } from '@/modules/database/migrations.js';

type NamedRow = Readonly<{ name: string }>;
type VersionRow = Readonly<{ version: number }>;

function tableNames(db: Database.Database): readonly string[] {
  return db.prepare<[], NamedRow>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'fleet_%' ORDER BY name",
  ).all().map(({ name }) => name);
}

test('creates fleet persistence when migrating a pre-fleet database twice', () => {
  // Given: a file-backed database journaled through the pre-fleet migration.
  const directory = mkdtempSync(join(tmpdir(), 'chatmux-fleet-migration-'));
  const filename = join(directory, 'legacy.sqlite');
  const db = new Database(filename);
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  for (let version = 1; version <= 16; version += 1) {
    db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(version);
  }

  try {
    // When: the current migrations run twice and the database is reopened.
    runMigrations(db);
    runMigrations(db);
    db.close();
    const reopened = new Database(filename);
    reopened.pragma('foreign_keys = ON');

    // Then: the fleet schema is complete, journaled once, and foreign-key clean.
    assert.deepEqual(tableNames(reopened), [
      'fleet_hub_grants',
      'fleet_pairing_tokens',
      'fleet_peers',
    ]);
    assert.deepEqual(
      reopened.prepare<[], VersionRow>('SELECT version FROM schema_migrations WHERE version = 17').all(),
      [{ version: 17 }],
    );
    assert.deepEqual(reopened.pragma('foreign_key_check'), []);
    reopened.close();
  } finally {
    if (db.open) db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('rolls back an interrupted fleet migration before journaling it', () => {
  // Given: migration 17 will collide with an incompatible pre-existing table.
  const db = new Database(':memory:');
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE fleet_peers (peer_id TEXT PRIMARY KEY);
  `);
  for (let version = 1; version <= 16; version += 1) {
    db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(version);
  }

  try {
    // When: the migration is interrupted by the incompatible schema.
    assert.throws(() => runMigrations(db));

    // Then: no partial fleet tables or migration journal entry remain.
    assert.deepEqual(tableNames(db), ['fleet_peers']);
    assert.equal(
      db.prepare<[], VersionRow>('SELECT version FROM schema_migrations WHERE version = 17').get(),
      undefined,
    );
    assert.deepEqual(db.pragma('foreign_key_check'), []);
  } finally {
    db.close();
  }
});

test('migration 18 drops the hub-grant self-reference while preserving pinned grants', () => {
  // Given: a version-17 database whose hub grants carry the impossible fleet_peers reference.
  const db = new Database(':memory:');
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  for (let version = 1; version <= 16; version += 1) {
    db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(version);
  }
  try {
    runMigrations(db);
    // Simulate the version-17 hub-grant shape by rebuilding it with the retired reference.
    db.pragma('foreign_keys = OFF');
    db.exec(`
      DROP TABLE fleet_hub_grants;
      CREATE TABLE fleet_hub_grants (
        grant_id INTEGER PRIMARY KEY AUTOINCREMENT,
        peer_id TEXT NOT NULL,
        hub_installation_id TEXT NOT NULL,
        pinned_public_key TEXT NOT NULL,
        pinned_public_key_fingerprint TEXT NOT NULL,
        grant_state TEXT NOT NULL DEFAULT 'active',
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        revoked_at_ms INTEGER,
        FOREIGN KEY (peer_id) REFERENCES fleet_peers(peer_id) ON DELETE CASCADE
      );
      INSERT INTO fleet_hub_grants (
        peer_id, hub_installation_id, pinned_public_key, pinned_public_key_fingerprint,
        created_at_ms, updated_at_ms
      ) VALUES (
        '00000000-0000-4000-8000-000000000001', 'hub-installation', 'hub-key', 'hub-fingerprint', 1, 1
      );
      DELETE FROM schema_migrations WHERE version = 18;
    `);
    db.pragma('foreign_keys = ON');

    // When: the current migrations run.
    runMigrations(db);

    // Then: the grant survives, the self-reference is gone, and foreign keys are clean.
    type GrantRow = Readonly<{ peer_id: string; pinned_public_key: string }>;
    assert.deepEqual(
      db.prepare<[], GrantRow>('SELECT peer_id, pinned_public_key FROM fleet_hub_grants').all(),
      [{ peer_id: '00000000-0000-4000-8000-000000000001', pinned_public_key: 'hub-key' }],
    );
    type ForeignKeyRow = Readonly<{ table: string }>;
    const references = db.pragma('foreign_key_list(fleet_hub_grants)') as readonly ForeignKeyRow[];
    assert.deepEqual(references.map(({ table }) => table), []);
    assert.deepEqual(db.pragma('foreign_key_check'), []);
    assert.deepEqual(
      db.prepare<[], VersionRow>('SELECT version FROM schema_migrations WHERE version = 18').all(),
      [{ version: 18 }],
    );
  } finally {
    db.close();
  }
});
