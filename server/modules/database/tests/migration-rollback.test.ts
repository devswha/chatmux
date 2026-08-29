import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { runMigrations } from '@/modules/database/migrations.js';
import {
  assertForeignKeysValid,
  count,
  createLegacyDatabase,
  foreignKeysEnabled,
  get,
  migrationVersions,
  seedJournalThrough,
  seedUserNotificationPreferencesDependency,
  type Row,
} from '@/modules/database/tests/support/migration-test-support.js';

type DestructiveFixture = {
  name: string;
  version: number;
  dropSql: string;
  seed: (db: Database.Database) => void;
  assertSourcePreserved: (db: Database.Database) => void;
  assertRecovered: (db: Database.Database) => void;
};

const seedRetiredCredentialTables = (db: Database.Database): void => {
  db.exec(`
    CREATE TABLE api_keys (api_key TEXT);
    INSERT INTO api_keys VALUES ('ck_secret');
    CREATE TABLE user_credentials (credential_value TEXT);
    INSERT INTO user_credentials VALUES ('github-secret');
  `);
};

const assertRetiredCredentialTablesPreserved = (db: Database.Database): void => {
  assert.deepEqual(get<Row>(db, 'SELECT * FROM api_keys'), { api_key: 'ck_secret' });
  assert.deepEqual(get<Row>(db, 'SELECT * FROM user_credentials'), { credential_value: 'github-secret' });
};

const assertRetiredCredentialTablesRemoved = (db: Database.Database): void => {
  assert.equal(
    get<Row>(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'api_keys'"),
    undefined,
  );
  assert.equal(
    get<Row>(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'user_credentials'"),
    undefined,
  );
};

const destructiveFixtures: DestructiveFixture[] = [
  {
    name: 'projects rebuild DROP',
    version: 4,
    dropSql: 'DROP TABLE projects',
    seed: (db) => {
      db.exec(`
        CREATE TABLE projects (project_id TEXT, workspace_path TEXT, custom_workspace_name TEXT);
        INSERT INTO projects VALUES ('project-1', '/repo/one', 'One');
      `);
      seedJournalThrough(db, 3);
      seedUserNotificationPreferencesDependency(db, 3);
    },
    assertSourcePreserved: (db) => assert.deepEqual(get<Row>(db, 'SELECT * FROM projects'), {
      project_id: 'project-1',
      workspace_path: '/repo/one',
      custom_workspace_name: 'One',
    }),
    assertRecovered: (db) => assert.equal(count(db, 'projects'), 1),
  },
  {
    name: 'sessions rebuild DROP',
    version: 6,
    dropSql: 'DROP TABLE sessions',
    seed: (db) => {
      db.exec(`
        CREATE TABLE projects (
          project_id TEXT PRIMARY KEY, project_path TEXT NOT NULL UNIQUE, custom_project_name TEXT,
          isStarred BOOLEAN DEFAULT 0, isArchived BOOLEAN DEFAULT 0
        );
        INSERT INTO projects VALUES ('project-1', '/repo/one', NULL, 0, 0);
        CREATE TABLE sessions (session_id TEXT, workspace_path TEXT, custom_name TEXT);
        INSERT INTO sessions VALUES ('session-1', '/repo/one', 'Preserve me');
      `);
      seedJournalThrough(db, 5);
      seedUserNotificationPreferencesDependency(db, 5);
    },
    assertSourcePreserved: (db) => assert.deepEqual(get<Row>(db, 'SELECT * FROM sessions'), {
      session_id: 'session-1',
      workspace_path: '/repo/one',
      custom_name: 'Preserve me',
    }),
    assertRecovered: (db) => assert.deepEqual(
      get<Row>(db, 'SELECT custom_name FROM sessions WHERE session_id = ?', 'session-1'),
      { custom_name: 'Preserve me' }
    ),
  },
  {
    name: 'legacy session_names DROP',
    version: 7,
    dropSql: 'DROP TABLE session_names',
    seed: (db) => {
      db.exec(`
        CREATE TABLE projects (
          project_id TEXT PRIMARY KEY, project_path TEXT NOT NULL UNIQUE, custom_project_name TEXT,
          isStarred BOOLEAN DEFAULT 0, isArchived BOOLEAN DEFAULT 0
        );
        CREATE TABLE sessions (
          session_id TEXT PRIMARY KEY, provider TEXT NOT NULL, custom_name TEXT, project_path TEXT,
          jsonl_path TEXT, isArchived BOOLEAN, created_at DATETIME, updated_at DATETIME
        );
        CREATE TABLE session_names (
          session_id TEXT, provider TEXT, custom_name TEXT, created_at DATETIME, updated_at DATETIME
        );
        INSERT INTO session_names VALUES ('session-1', 'codex', 'Preserve me', '2024-01-01', '2024-01-01');
      `);
      seedJournalThrough(db, 6);
      seedUserNotificationPreferencesDependency(db, 6);
    },
    assertSourcePreserved: (db) => assert.deepEqual(get<Row>(db, 'SELECT * FROM session_names'), {
      session_id: 'session-1',
      provider: 'codex',
      custom_name: 'Preserve me',
      created_at: '2024-01-01',
      updated_at: '2024-01-01',
    }),
    assertRecovered: (db) => assert.deepEqual(
      get<Row>(db, 'SELECT provider, custom_name FROM sessions WHERE session_id = ?', 'session-1'),
      { provider: 'codex', custom_name: 'Preserve me' }
    ),
  },
  {
    name: 'workspace_original_paths DROP',
    version: 11,
    dropSql: 'DROP TABLE workspace_original_paths',
    seed: (db) => {
      db.exec(`
        CREATE TABLE projects (
          project_id TEXT PRIMARY KEY, project_path TEXT NOT NULL UNIQUE, custom_project_name TEXT,
          isStarred BOOLEAN DEFAULT 0, isArchived BOOLEAN DEFAULT 0
        );
        CREATE TABLE sessions (
          session_id TEXT PRIMARY KEY, provider TEXT NOT NULL, provider_session_id TEXT, custom_name TEXT,
          project_path TEXT, jsonl_path TEXT, isArchived BOOLEAN, created_at DATETIME, updated_at DATETIME
        );
        CREATE TABLE workspace_original_paths (workspace_id TEXT, workspace_path TEXT);
        INSERT INTO workspace_original_paths VALUES ('project-1', '/repo/one');
      `);
      seedJournalThrough(db, 10);
      seedUserNotificationPreferencesDependency(db, 10);
    },
    assertSourcePreserved: (db) => assert.deepEqual(get<Row>(db, 'SELECT * FROM workspace_original_paths'), {
      workspace_id: 'project-1',
      workspace_path: '/repo/one',
    }),
    assertRecovered: (db) => assert.equal(
      get<Row>(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workspace_original_paths'"),
      undefined
    ),
  },
  {
    name: 'retired api_keys DROP',
    version: 15,
    dropSql: 'DROP TABLE IF EXISTS api_keys',
    seed: (db) => {
      seedRetiredCredentialTables(db);
      seedJournalThrough(db, 14);
    },
    assertSourcePreserved: assertRetiredCredentialTablesPreserved,
    assertRecovered: assertRetiredCredentialTablesRemoved,
  },
  {
    name: 'retired user_credentials DROP',
    version: 15,
    dropSql: 'DROP TABLE IF EXISTS user_credentials',
    seed: (db) => {
      seedRetiredCredentialTables(db);
      seedJournalThrough(db, 14);
    },
    assertSourcePreserved: assertRetiredCredentialTablesPreserved,
    assertRecovered: assertRetiredCredentialTablesRemoved,
  },
];

for (const fixture of destructiveFixtures) {
  for (const phase of ['before drop', 'after drop before commit'] as const) {
    test(`rolls back ${fixture.name} failure injected ${phase}`, () => {
      const directory = mkdtempSync(join(tmpdir(), 'chatmux-migrations-'));
      const filename = join(directory, 'database.sqlite');
      let db = createLegacyDatabase(filename);
      try {
        fixture.seed(db);
        const originalExec = db.exec.bind(db);
        let dropSeen = false;
        Object.defineProperty(db, 'exec', {
          configurable: true,
          value: (sql: string): Database.Database => {
            if (sql === fixture.dropSql) {
              if (phase === 'before drop') {
                throw new Error(`injected ${phase}: ${fixture.name}`);
              }
              dropSeen = true;
            }
            if (phase === 'after drop before commit' && dropSeen && sql === 'COMMIT') {
              throw new Error(`injected ${phase}: ${fixture.name}`);
            }
            return originalExec(sql);
          },
        });

        assert.throws(() => runMigrations(db), /injected/);
        assert.equal(foreignKeysEnabled(db), 1);
        assert.equal(migrationVersions(db).includes(fixture.version), false);
        fixture.assertSourcePreserved(db);
        db.close();

        db = new Database(filename);
        db.exec('PRAGMA foreign_keys = ON');
        fixture.assertSourcePreserved(db);
        assert.equal(foreignKeysEnabled(db), 1);
        runMigrations(db);
        fixture.assertRecovered(db);
        assert.equal(migrationVersions(db).includes(fixture.version), true);
        assertForeignKeysValid(db);
      } finally {
        db.close();
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }
}
