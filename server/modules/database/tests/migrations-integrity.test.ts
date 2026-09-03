import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { runMigrations } from '@/modules/database/migrations.js';
import {
  all,
  assertForeignKeysValid,
  columnNames,
  createLegacyDatabase,
  get,
  migrationVersions,
  seedJournalThrough,
  type Row,
} from '@/modules/database/tests/support/migration-test-support.js';

test('initialization repairs partial generation state before creating its stale index', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'migration-initialization-'));
  const filename = join(directory, 'auth.db');
  const previousDatabasePath = process.env.DATABASE_PATH;
  const db = createLegacyDatabase(filename);

  try {
    seedJournalThrough(db, 12);
    db.exec('ALTER TABLE users ADD COLUMN is_active BOOLEAN NOT NULL DEFAULT 1');
    db.exec(`
      CREATE TABLE completion_notification_generation_state (
        generation_target_id INTEGER PRIMARY KEY,
        high_water_seq INTEGER NOT NULL DEFAULT 0,
        armed_seq INTEGER,
        monitor_state TEXT NOT NULL DEFAULT 'unobserved',
        last_evidence_cursor TEXT,
        state_revision INTEGER NOT NULL DEFAULT 1,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
    db.close();

    closeConnection();
    process.env.DATABASE_PATH = filename;
    await initializeDatabase();

    const initializedDb = getConnection();
    assert.equal(columnNames(initializedDb, 'completion_notification_generation_state').includes('pane_evidence_key'), true);
    assert.equal(columnNames(initializedDb, 'completion_notification_generation_state').includes('last_seen_at'), true);
    assert.ok(get<Row>(initializedDb, `SELECT name FROM sqlite_master
      WHERE type = 'index' AND name = 'idx_completion_notification_generation_state_stale'`));

    await initializeDatabase();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    rmSync(directory, { recursive: true, force: true });
  }
});

test('replays a complete pre-journal database without changing data, schema, or foreign keys', () => {
  const db = createLegacyDatabase();
  try {
    runMigrations(db);
    db.exec(`
      INSERT INTO projects (project_id, project_path, custom_project_name) VALUES ('project-1', '/repo/one', 'One');
      INSERT INTO sessions (session_id, provider, provider_session_id, custom_name, project_path)
      VALUES ('session-1', 'codex', 'provider-1', 'Session', '/repo/one');
      DROP TABLE schema_migrations;
    `);

    const snapshot = () => ({
      schema: all<Row>(
        db,
        "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations' ORDER BY name"
      ),
      projects: all<Row>(db, 'SELECT * FROM projects ORDER BY project_path'),
      sessions: all<Row>(db, 'SELECT * FROM sessions ORDER BY session_id'),
      foreignKeys: all<Row>(db, 'PRAGMA foreign_key_list(sessions)'),
      foreignKeyCheck: all<Row>(db, 'PRAGMA foreign_key_check'),
    });
    const beforeReplay = snapshot();

    runMigrations(db);
    assert.deepEqual(snapshot(), beforeReplay);
    assert.deepEqual(migrationVersions(db), Array.from({ length: 21 }, (_, index) => index + 1));

    const afterReplay = snapshot();
    runMigrations(db);
    assert.deepEqual(snapshot(), afterReplay);
    assert.deepEqual(migrationVersions(db), Array.from({ length: 21 }, (_, index) => index + 1));
    assertForeignKeysValid(db);

  } finally {
    db.close();
  }
});
test('migration 16 adds the decision-key-leading outbox index to existing databases', () => {
  const db = createLegacyDatabase();
  try {
    runMigrations(db);
    db.exec(`DROP INDEX idx_completion_notification_outbox_decision_key;
      DELETE FROM schema_migrations WHERE version = 16`);

    runMigrations(db);
    assert.match(
      get<{ sql: string }>(db,
        "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_completion_notification_outbox_decision_key'")!.sql,
      /ON completion_notification_outbox\s*\(decision_key, user_id, id\)/,
    );
  } finally {
    db.close();
  }
});
