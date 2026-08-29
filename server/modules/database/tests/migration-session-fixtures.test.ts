import assert from 'node:assert/strict';
import test from 'node:test';

import { runMigrations } from '@/modules/database/migrations.js';
import {
  all,
  assertForeignKeysValid,
  columnNames,
  count,
  completionNotificationTables,
  createLegacyDatabase,
  get,
  migrationVersions,
  seedJournalThrough,
  type MigrationFixture,
  type Row,
  type TableInfoRow,
} from '@/modules/database/tests/support/migration-test-support.js';

const fixtures: readonly MigrationFixture[] = [
  {
    id: 'FX-4 rebuilds sessions and merges session_names',
    seed: (db) => {
      db.exec(`
        CREATE TABLE projects (project_id TEXT PRIMARY KEY, project_path TEXT NOT NULL UNIQUE);
        INSERT INTO projects VALUES ('project-1', '/repo/one');
        CREATE TABLE sessions (session_id TEXT, workspace_path TEXT, custom_name TEXT, updated_at DATETIME);
        INSERT INTO sessions VALUES ('session-1', '/repo/one', 'Old session', '2024-01-01');
        CREATE TABLE session_names (
          session_id TEXT, provider TEXT, custom_name TEXT, created_at DATETIME, updated_at DATETIME
        );
        INSERT INTO session_names VALUES ('session-2', 'codex', 'Named session', '2024-02-01', '2024-02-02');
      `);
    },
    verify: (db) => {
      assert.equal(count(db, 'sessions'), 2);
      assert.deepEqual(
        get<Row>(db, 'SELECT provider, provider_session_id, project_path FROM sessions WHERE session_id = ?', 'session-1'),
        { provider: 'claude', provider_session_id: 'session-1', project_path: '/repo/one' }
      );
      assert.equal(get<Row>(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_names'"), undefined);
    },
  },
  {
    id: 'FX-4b adds fields to post-rebuild sessions',
    seed: (db) => {
      db.exec(`
        CREATE TABLE projects (project_id TEXT PRIMARY KEY, project_path TEXT NOT NULL UNIQUE);
        INSERT INTO projects VALUES ('project-1', '/repo/one');
        CREATE TABLE sessions (
          session_id TEXT PRIMARY KEY, provider TEXT NOT NULL DEFAULT 'claude', custom_name TEXT, project_path TEXT
        );
        INSERT INTO sessions VALUES ('session-1', 'claude', 'Existing', '/repo/one');
      `);
    },
    verify: (db) => {
      assert.deepEqual(columnNames(db, 'sessions').sort(), [
        'created_at',
        'custom_name',
        'jsonl_path',
        'project_path',
        'provider',
        'provider_session_id',
        'session_id',
        'updated_at',
      ]);
    },
  },
  {
    id: 'FX-5 backfills provider session IDs',
    seed: (db) => {
      db.exec(`
        CREATE TABLE projects (
          project_id TEXT PRIMARY KEY, project_path TEXT NOT NULL UNIQUE, custom_project_name TEXT,
          isStarred BOOLEAN DEFAULT 0, isArchived BOOLEAN DEFAULT 0
        );
        CREATE TABLE sessions (
          session_id TEXT PRIMARY KEY, provider TEXT NOT NULL DEFAULT 'claude', custom_name TEXT, project_path TEXT,
          jsonl_path TEXT, isArchived BOOLEAN DEFAULT 0, created_at DATETIME, updated_at DATETIME
        );
        INSERT INTO sessions VALUES ('session-1', 'codex', 'Existing', NULL, NULL, 0, '2024-01-01', '2024-01-01');
      `);
    },
    verify: (db) => {
      assert.deepEqual(
        get<Row>(db, 'SELECT provider, provider_session_id FROM sessions WHERE session_id = ?', 'session-1'),
        { provider: 'codex', provider_session_id: 'session-1' }
      );
    },
  },
  {
    id: 'FX-6 safely reruns a current database',
    seed: (db) => {
      runMigrations(db);
    },
    verify: (db) => {
      assert.deepEqual(migrationVersions(db), Array.from({ length: 19 }, (_, index) => index + 1));
      assert.equal(
        get<Row>(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'api_keys'"),
        undefined,
      );
      assert.equal(
        get<Row>(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'user_credentials'"),
        undefined,
      );
      assert.ok(get<Row>(db, "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_sessions_provider_session_id'"));
      assert.match(
        get<{ sql: string }>(db, "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_completion_notification_outbox_decision_key'")!.sql,
        /ON completion_notification_outbox\s*\(decision_key, user_id, id\)/,
      );
      assert.deepEqual(
        all<TableInfoRow>(
          db,
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'completion_notification_%' ORDER BY name"
        ).map(({ name }) => name),
        completionNotificationTables
      );
      assert.deepEqual(
        get<Row>(
          db,
          'SELECT user_id, desired_web_push, consent_configured, enforcement_enabled FROM completion_notification_policy'
        ),
        { user_id: 1, desired_web_push: 0, consent_configured: 0, enforcement_enabled: 1 }
      );
    },
  },
  {
    id: 'FX-7 removes archive fields while preserving archived rows',
    seed: (db) => {
      db.exec(`
        CREATE TABLE projects (
          project_id TEXT PRIMARY KEY,
          project_path TEXT NOT NULL UNIQUE,
          custom_project_name TEXT,
          isStarred BOOLEAN DEFAULT 0,
          isArchived BOOLEAN DEFAULT 0
        );
        INSERT INTO projects VALUES ('project-archived', '/repo/archived', 'Archived project', 1, 1);
        CREATE TABLE sessions (
          session_id TEXT PRIMARY KEY,
          provider TEXT NOT NULL DEFAULT 'claude',
          provider_session_id TEXT,
          custom_name TEXT,
          project_path TEXT,
          jsonl_path TEXT,
          isArchived BOOLEAN DEFAULT 0,
          created_at DATETIME,
          updated_at DATETIME,
          FOREIGN KEY (project_path) REFERENCES projects(project_path)
            ON DELETE SET NULL
            ON UPDATE CASCADE
        );
        INSERT INTO sessions VALUES (
          'session-archived', 'codex', 'provider-archived', 'Archived session', '/repo/archived',
          '/repo/archived/session.jsonl', 1, '2024-01-01', '2024-01-02'
        );
        CREATE INDEX idx_sessions_is_archived ON sessions(isArchived);
        CREATE INDEX idx_projects_is_archived ON projects(isArchived);
      `);
      seedJournalThrough(db, 13);
    },
    verify: (db) => {
      assert.deepEqual(columnNames(db, 'projects').sort(), [
        'custom_project_name',
        'isStarred',
        'project_id',
        'project_path',
      ]);
      assert.deepEqual(columnNames(db, 'sessions').sort(), [
        'created_at',
        'custom_name',
        'jsonl_path',
        'project_path',
        'provider',
        'provider_session_id',
        'session_id',
        'updated_at',
      ]);
      assert.deepEqual(
        get<Row>(
          db,
          'SELECT project_id, project_path, custom_project_name, isStarred FROM projects WHERE project_id = ?',
          'project-archived'
        ),
        {
          project_id: 'project-archived',
          project_path: '/repo/archived',
          custom_project_name: 'Archived project',
          isStarred: 1,
        }
      );
      assert.deepEqual(
        get<Row>(
          db,
          `SELECT session_id, provider, provider_session_id, custom_name, project_path, jsonl_path, created_at, updated_at
           FROM sessions WHERE session_id = ?`,
          'session-archived'
        ),
        {
          session_id: 'session-archived',
          provider: 'codex',
          provider_session_id: 'provider-archived',
          custom_name: 'Archived session',
          project_path: '/repo/archived',
          jsonl_path: '/repo/archived/session.jsonl',
          created_at: '2024-01-01',
          updated_at: '2024-01-02',
        }
      );
      assert.equal(
        get<Row>(db, "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_sessions_is_archived'"),
        undefined
      );
      assert.equal(
        get<Row>(db, "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_projects_is_archived'"),
        undefined
      );
    },
  },
];

for (const fixture of fixtures) {
  test(`migrates independent ${fixture.id} fixture`, () => {
    const db = createLegacyDatabase();
    try {
      fixture.seed(db);
      runMigrations(db);
      fixture.verify(db);
      assertForeignKeysValid(db);
    } finally {
      db.close();
    }
  });
}
