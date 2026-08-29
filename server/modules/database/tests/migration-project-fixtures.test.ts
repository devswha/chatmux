import assert from 'node:assert/strict';
import test from 'node:test';

import { runMigrations } from '@/modules/database/migrations.js';
import {
  all,
  assertForeignKeysValid,
  columnNames,
  count,
  createLegacyDatabase,
  get,
  type MigrationFixture,
  type Row,
} from '@/modules/database/tests/support/migration-test-support.js';

const fixtures: readonly MigrationFixture[] = [
  {
    id: 'FX-1 adds missing user fields',
    seed: () => undefined,
    verify: (db) => {
      assert.deepEqual(columnNames(db, 'users').sort(), [
        'git_email',
        'git_name',
        'has_completed_onboarding',
        'id',
        'password_hash',
        'username',
      ]);
    },
  },
  {
    id: 'FX-2 migrates legacy workspace tables',
    seed: (db) => {
      db.exec(`
        CREATE TABLE workspaces (workspace_path TEXT PRIMARY KEY);
        CREATE TABLE workspace_original_paths (
          workspace_id TEXT, workspace_path TEXT, custom_workspace_name TEXT, isStarred BOOLEAN
        );
        INSERT INTO workspaces VALUES ('/repo/one');
        INSERT INTO workspace_original_paths VALUES ('project-1', '/repo/one', 'One', 1);
      `);
    },
    verify: (db) => {
      assert.deepEqual(get<Row>(db, 'SELECT project_id, project_path, custom_project_name, isStarred FROM projects'), {
        project_id: 'project-1',
        project_path: '/repo/one',
        custom_project_name: 'One',
        isStarred: 1,
      });
      assert.equal(get<Row>(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workspace_original_paths'"), undefined);
    },
  },
  {
    id: 'FX-3 rebuilds pre-primary-key projects',
    seed: (db) => {
      db.exec(`
        CREATE TABLE projects (project_id TEXT, workspace_path TEXT, custom_workspace_name TEXT, isStarred BOOLEAN);
        INSERT INTO projects VALUES ('project-1', '/repo/one', 'One', 1);
        INSERT INTO projects VALUES ('project-1', '/repo/two', 'Two', 0);
      `);
    },
    verify: (db) => {
      assert.equal(count(db, 'projects'), 2);
      assert.equal(
        all<Row>(db, 'PRAGMA table_info(projects)').some(
          (column) => column.name === 'project_id' && column.pk === 1
        ),
        true
      );
    },
  },
  {
    id: 'FX-3b backfills additive project columns',
    seed: (db) => {
      db.exec(`
        CREATE TABLE projects (project_id TEXT PRIMARY KEY, project_path TEXT NOT NULL UNIQUE);
        INSERT INTO projects VALUES ('', '/repo/one');
      `);
    },
    verify: (db) => {
      assert.deepEqual(columnNames(db, 'projects').sort(), [
        'custom_project_name',
        'isStarred',
        'project_id',
        'project_path',
      ]);
      const project = get<{ project_id: string }>(db, 'SELECT project_id FROM projects WHERE project_path = ?', '/repo/one');
      assert.ok(project, 'expected migrated project');
      assert.notEqual(project.project_id, '');
    },
  },
  {
    id: 'FX-8 synthesizes missing projects for session paths',
    seed: (db) => {
      db.exec(`
        CREATE TABLE projects (
          project_id TEXT PRIMARY KEY, project_path TEXT NOT NULL UNIQUE, custom_project_name TEXT,
          isStarred BOOLEAN DEFAULT 0, isArchived BOOLEAN DEFAULT 0
        );
        CREATE TABLE sessions (
          session_id TEXT PRIMARY KEY, provider TEXT NOT NULL DEFAULT 'claude', provider_session_id TEXT,
          custom_name TEXT, project_path TEXT, jsonl_path TEXT, isArchived BOOLEAN DEFAULT 0,
          created_at DATETIME, updated_at DATETIME
        );
        INSERT INTO sessions VALUES ('session-1', 'codex', 'provider-1', 'Orphan', '/repo/missing', NULL, 0, '2024-01-01', '2024-01-01');
      `);
    },
    verify: (db) => {
      assert.equal(count(db, 'projects'), 1);
      assert.equal(count(db, 'projects WHERE project_path = \'/repo/missing\''), 1);
      assertForeignKeysValid(db);
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
