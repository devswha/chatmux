import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { runMigrations } from '@/modules/database/migrations.js';

type Row = Record<string, unknown>;
type TableInfoRow = { name: string };
type VersionRow = { version: number };
type CountRow = { count: number };
type ForeignKeysRow = { foreign_keys: number };

const get = <T extends Row>(db: Database.Database, sql: string, ...parameters: unknown[]): T | undefined =>
  db.prepare(sql).get(...parameters) as T | undefined;

const all = <T extends Row>(db: Database.Database, sql: string, ...parameters: unknown[]): T[] =>
  db.prepare(sql).all(...parameters) as T[];

const createLegacyDatabase = (filename = ':memory:'): Database.Database => {
  const db = new Database(filename);
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL
    );
    INSERT INTO users (id, username, password_hash) VALUES (1, 'legacy', 'hash');
  `);
  return db;
};

const columnNames = (db: Database.Database, table: string): string[] =>
  all<TableInfoRow>(db, `PRAGMA table_info(${table})`).map(({ name }) => name);

const migrationVersions = (db: Database.Database): number[] =>
  all<VersionRow>(db, 'SELECT version FROM schema_migrations ORDER BY version').map(({ version }) => version);

const count = (db: Database.Database, table: string): number => {
  const result = get<CountRow>(db, `SELECT count(*) AS count FROM ${table}`);
  assert.ok(result, `expected count for ${table}`);
  return result.count;
};

const foreignKeysEnabled = (db: Database.Database): number => {
  const result = get<ForeignKeysRow>(db, 'PRAGMA foreign_keys');
  assert.ok(result, 'expected foreign key pragma result');
  return result.foreign_keys;
};

const assertForeignKeysValid = (db: Database.Database): void => {
  assert.equal(all<Row>(db, 'PRAGMA foreign_key_check').length, 0);
  assert.equal(foreignKeysEnabled(db), 1);
};

const seedJournalThrough = (db: Database.Database, version: number): void => {
  db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)');
  for (let currentVersion = 1; currentVersion <= version; currentVersion += 1) {
    db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(currentVersion);
  }
};

const fxFixtures: Array<{ id: string; seed: (db: Database.Database) => void; verify: (db: Database.Database) => void }> = [
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
        'isArchived',
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
        'isArchived',
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
      assert.deepEqual(migrationVersions(db), Array.from({ length: 12 }, (_, index) => index + 1));
      assert.ok(get<Row>(db, "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_sessions_provider_session_id'"));
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

for (const fixture of fxFixtures) {
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
    assert.deepEqual(migrationVersions(db), Array.from({ length: 12 }, (_, index) => index + 1));

    const afterReplay = snapshot();
    runMigrations(db);
    assert.deepEqual(snapshot(), afterReplay);
    assert.deepEqual(migrationVersions(db), Array.from({ length: 12 }, (_, index) => index + 1));
    assertForeignKeysValid(db);
  } finally {
    db.close();
  }
});

type DestructiveFixture = {
  name: string;
  version: number;
  dropSql: string;
  seed: (db: Database.Database) => void;
  assertSourcePreserved: (db: Database.Database) => void;
  assertRecovered: (db: Database.Database) => void;
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
        (db as unknown as { exec: (sql: string) => Database.Database }).exec = (sql) => {
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
        };

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
