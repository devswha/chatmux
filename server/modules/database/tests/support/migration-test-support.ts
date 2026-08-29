import assert from 'node:assert/strict';

import Database from 'better-sqlite3';

export type Row = Record<string, unknown>;
export type TableInfoRow = { readonly name: string };
type VersionRow = { readonly version: number };
type CountRow = { readonly count: number };
type ForeignKeysRow = { readonly foreign_keys: number };

export type MigrationFixture = {
  readonly id: string;
  readonly seed: (db: Database.Database) => void;
  readonly verify: (db: Database.Database) => void;
};

export const get = <T extends Row>(
  db: Database.Database,
  sql: string,
  ...parameters: readonly unknown[]
): T | undefined => db.prepare(sql).get(...parameters) as T | undefined;

export const all = <T extends Row>(
  db: Database.Database,
  sql: string,
  ...parameters: readonly unknown[]
): T[] => db.prepare(sql).all(...parameters) as T[];

export const createLegacyDatabase = (filename = ':memory:'): Database.Database => {
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

export const columnNames = (db: Database.Database, table: string): string[] =>
  all<TableInfoRow>(db, `PRAGMA table_info(${table})`).map(({ name }) => name);

export const migrationVersions = (db: Database.Database): number[] =>
  all<VersionRow>(db, 'SELECT version FROM schema_migrations ORDER BY version')
    .map(({ version }) => version);

export const count = (db: Database.Database, table: string): number => {
  const result = get<CountRow>(db, `SELECT count(*) AS count FROM ${table}`);
  assert.ok(result, `expected count for ${table}`);
  return result.count;
};

export const foreignKeysEnabled = (db: Database.Database): number => {
  const result = get<ForeignKeysRow>(db, 'PRAGMA foreign_keys');
  assert.ok(result, 'expected foreign key pragma result');
  return result.foreign_keys;
};

export const assertForeignKeysValid = (db: Database.Database): void => {
  assert.equal(all<Row>(db, 'PRAGMA foreign_key_check').length, 0);
  assert.equal(foreignKeysEnabled(db), 1);
};

export const seedJournalThrough = (db: Database.Database, version: number): void => {
  db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)');
  for (let currentVersion = 1; currentVersion <= version; currentVersion += 1) {
    db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(currentVersion);
  }
};

export const seedUserNotificationPreferencesDependency = (
  db: Database.Database,
  version: number,
): void => {
  if (version >= 2) {
    db.exec(`
      CREATE TABLE user_notification_preferences (
        user_id INTEGER PRIMARY KEY,
        preferences_json TEXT NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
    `);
  }
};

export const completionNotificationTables = [
  'completion_notification_aliases',
  'completion_notification_deliveries',
  'completion_notification_generation_state',
  'completion_notification_outbox',
  'completion_notification_policy',
  'completion_notification_redirect_authorizations',
  'completion_notification_targets',
  'completion_notification_watch_mutations',
  'completion_notification_watches',
] as const;
