import { Database } from 'better-sqlite3';

import {
  APP_CONFIG_TABLE_SCHEMA_SQL,
  COMPLETION_NOTIFICATION_GENERATION_STATE_STALE_INDEX_SQL,
  COMPLETION_NOTIFICATION_SCHEMA_SQL,
  LAST_SCANNED_AT_SQL,
  PROJECTS_TABLE_SCHEMA_SQL,
  PUSH_SUBSCRIPTIONS_TABLE_SCHEMA_SQL,
  USER_NOTIFICATION_PREFERENCES_TABLE_SCHEMA_SQL,
  USER_NOTIFICATION_PREFERENCES_LIVE_STOP_LATCH_SQL,
  VAPID_KEYS_TABLE_SCHEMA_SQL,
} from '@/modules/database/schema.js';

const SQLITE_UUID_SQL = `
lower(hex(randomblob(4))) || '-' ||
lower(hex(randomblob(2))) || '-' ||
lower(hex(randomblob(2))) || '-' ||
lower(hex(randomblob(2))) || '-' ||
lower(hex(randomblob(6)))
`;

type TableInfoRow = {
  name: string;
  pk: number;
};
type IndexListRow = {
  name: string;
};

type IndexInfoRow = {
  name: string;
};

const quoteIdentifier = (identifier: string): string => `"${identifier.replaceAll('"', '""')}"`;

const dropIndexesForColumn = (db: Database, tableName: string, columnName: string): void => {
  const indexes = db.prepare(`PRAGMA index_list(${tableName})`).all() as IndexListRow[];

  for (const { name } of indexes) {
    const columns = db.prepare(`PRAGMA index_info(${quoteIdentifier(name)})`).all() as IndexInfoRow[];
    if (columns.some((column) => column.name === columnName)) {
      db.exec(`DROP INDEX IF EXISTS ${quoteIdentifier(name)}`);
    }
  }
};

const activateArchivedRows = (db: Database, tableName: string): void => {
  if (!tableExists(db, tableName)) {
    return;
  }

  const columnNames = getTableInfo(db, tableName).map((column) => column.name);
  if (columnNames.includes('isArchived')) {
    db.exec(`UPDATE ${tableName} SET isArchived = 0`);
  }
};

const removeArchiveColumn = (db: Database, tableName: string): void => {
  if (!tableExists(db, tableName)) {
    return;
  }

  const columnNames = getTableInfo(db, tableName).map((column) => column.name);
  if (!columnNames.includes('isArchived')) {
    return;
  }

  dropIndexesForColumn(db, tableName, 'isArchived');
  db.exec(`ALTER TABLE ${tableName} DROP COLUMN isArchived`);
};

const addColumnToTableIfNotExists = (
  db: Database,
  tableName: string,
  columnNames: string[],
  columnName: string,
  columnType: string
) => {
  if (!columnNames.includes(columnName)) {
    console.log(`Running migration: Adding ${columnName} column to ${tableName} table`);
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnType}`);
  }
};

const tableExists = (db: Database, tableName: string): boolean =>
  Boolean(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(tableName)
  );

const getTableInfo = (db: Database, tableName: string): TableInfoRow[] =>
  db.prepare(`PRAGMA table_info(${tableName})`).all() as TableInfoRow[];

const migrateLegacySessionNames = (db: Database): void => {
  const hasLegacySessionNamesTable = tableExists(db, 'session_names');
  const hasSessionsTable = tableExists(db, 'sessions');

  if (!hasLegacySessionNamesTable) {
    return;
  }

  if (hasSessionsTable) {
    console.log('Running migration: Merging session_names into sessions');
    db.exec(`
      INSERT INTO sessions (session_id, provider, custom_name, created_at, updated_at)
      SELECT
        session_id,
        COALESCE(provider, 'claude'),
        custom_name,
        COALESCE(created_at, CURRENT_TIMESTAMP),
        COALESCE(updated_at, CURRENT_TIMESTAMP)
      FROM session_names
      WHERE true
      ON CONFLICT(session_id) DO UPDATE SET
        provider = excluded.provider,
        custom_name = COALESCE(excluded.custom_name, sessions.custom_name),
        created_at = COALESCE(sessions.created_at, excluded.created_at),
        updated_at = COALESCE(excluded.updated_at, sessions.updated_at)
    `);
    db.exec('DROP TABLE session_names');
    return;
  }

  console.log('Running migration: Renaming session_names table to sessions');
  db.exec('ALTER TABLE session_names RENAME TO sessions');
};

const migrateLegacyWorkspaceTableIntoProjects = (db: Database): void => {
  db.exec(PROJECTS_TABLE_SCHEMA_SQL);

  if (!tableExists(db, 'workspace_original_paths')) {
    return;
  }

  console.log('Running migration: Migrating workspace_original_paths data into projects');
  db.exec(`
    INSERT INTO projects (project_id, project_path, custom_project_name, isStarred, isArchived)
    SELECT
      CASE
        WHEN workspace_id IS NULL OR trim(workspace_id) = ''
        THEN ${SQLITE_UUID_SQL}
        ELSE workspace_id
      END,
      workspace_path,
      custom_workspace_name,
      COALESCE(isStarred, 0),
      0
    FROM workspace_original_paths
    WHERE workspace_path IS NOT NULL AND trim(workspace_path) <> ''
    ON CONFLICT(project_path) DO UPDATE SET
      custom_project_name = COALESCE(projects.custom_project_name, excluded.custom_project_name),
      isStarred = COALESCE(projects.isStarred, excluded.isStarred)
  `);
};

const rebuildProjectsTableWithPrimaryKeySchema = (db: Database): void => {
  const hasProjectsTable = tableExists(db, 'projects');
  if (!hasProjectsTable) {
    db.exec(PROJECTS_TABLE_SCHEMA_SQL);
    return;
  }

  const projectsTableInfo = getTableInfo(db, 'projects');
  const columnNames = projectsTableInfo.map((column) => column.name);
  const hasProjectIdPrimaryKey = projectsTableInfo.some(
    (column) => column.name === 'project_id' && column.pk === 1,
  );

  if (hasProjectIdPrimaryKey) {
    addColumnToTableIfNotExists(db, 'projects', columnNames, 'custom_project_name', 'TEXT DEFAULT NULL');
    addColumnToTableIfNotExists(db, 'projects', columnNames, 'isStarred', 'BOOLEAN DEFAULT 0');
    addColumnToTableIfNotExists(db, 'projects', columnNames, 'isArchived', 'BOOLEAN DEFAULT 0');
    db.exec(`
      UPDATE projects
      SET project_id = ${SQLITE_UUID_SQL}
      WHERE project_id IS NULL OR trim(project_id) = ''
    `);
    return;
  }

  console.log('Running migration: Rebuilding projects table to enforce project_id primary key');

  const projectPathExpression = columnNames.includes('project_path')
    ? 'project_path'
    : columnNames.includes('workspace_path')
      ? 'workspace_path'
      : 'NULL';

  const customProjectNameExpression = columnNames.includes('custom_project_name')
    ? 'custom_project_name'
    : columnNames.includes('custom_workspace_name')
      ? 'custom_workspace_name'
      : 'NULL';

  const isStarredExpression = columnNames.includes('isStarred') ? 'COALESCE(isStarred, 0)' : '0';

  const isArchivedExpression = columnNames.includes('isArchived') ? 'COALESCE(isArchived, 0)' : '0';

  const projectIdExpression = columnNames.includes('project_id')
    ? `CASE
         WHEN project_id IS NULL OR trim(project_id) = ''
         THEN ${SQLITE_UUID_SQL}
         ELSE project_id
       END`
    : SQLITE_UUID_SQL;

  db.exec('DROP TABLE IF EXISTS projects__new');
  db.exec(`
      CREATE TABLE projects__new (
        project_id TEXT PRIMARY KEY NOT NULL,
        project_path TEXT NOT NULL UNIQUE,
        custom_project_name TEXT DEFAULT NULL,
        isStarred BOOLEAN DEFAULT 0,
        isArchived BOOLEAN DEFAULT 0
      )
    `);
  db.exec(`
      WITH source_rows AS (
        SELECT
          ${projectPathExpression} AS project_path,
          ${customProjectNameExpression} AS custom_project_name,
          ${isStarredExpression} AS isStarred,
          ${isArchivedExpression} AS isArchived,
          ${projectIdExpression} AS candidate_project_id,
          rowid AS source_rowid
        FROM projects
        WHERE ${projectPathExpression} IS NOT NULL AND trim(${projectPathExpression}) <> ''
      ),
      deduped_paths AS (
        SELECT
          project_path,
          custom_project_name,
          isStarred,
          isArchived,
          candidate_project_id,
          source_rowid,
          ROW_NUMBER() OVER (PARTITION BY project_path ORDER BY source_rowid) AS project_path_rank
        FROM source_rows
      ),
      prepared_rows AS (
        SELECT
          CASE
            WHEN ROW_NUMBER() OVER (PARTITION BY candidate_project_id ORDER BY source_rowid) = 1
            THEN candidate_project_id
            ELSE ${SQLITE_UUID_SQL}
          END AS project_id,
          project_path,
          custom_project_name,
          isStarred,
          isArchived
        FROM deduped_paths
        WHERE project_path_rank = 1
      )
      INSERT INTO projects__new (
        project_id,
        project_path,
        custom_project_name,
        isStarred,
        isArchived
      )
      SELECT
        project_id,
        project_path,
        custom_project_name,
        isStarred,
        isArchived
      FROM prepared_rows
    `);
  db.exec('DROP TABLE projects');
  db.exec('ALTER TABLE projects__new RENAME TO projects');
};

const LEGACY_SESSIONS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT NOT NULL,
    provider TEXT NOT NULL DEFAULT 'claude',
    provider_session_id TEXT,
    custom_name TEXT,
    project_path TEXT,
    jsonl_path TEXT,
    isArchived BOOLEAN DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (session_id),
    FOREIGN KEY (project_path) REFERENCES projects(project_path)
    ON DELETE SET NULL
    ON UPDATE CASCADE
);
`;

const rebuildSessionsTableWithProjectSchema = (db: Database): void => {
  const hasSessions = tableExists(db, 'sessions');
  if (!hasSessions) {
    db.exec(LEGACY_SESSIONS_TABLE_SCHEMA_SQL);
    return;
  }

  const sessionsTableInfo = getTableInfo(db, 'sessions');
  const columnNames = sessionsTableInfo.map((column) => column.name);
  const primaryKeyColumns = sessionsTableInfo
    .filter((column) => column.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((column) => column.name);

  const shouldRebuild =
    !columnNames.includes('project_path') ||
    primaryKeyColumns.length !== 1 ||
    primaryKeyColumns[0] !== 'session_id' ||
    !columnNames.includes('provider');

  if (!shouldRebuild) {
    addColumnToTableIfNotExists(db, 'sessions', columnNames, 'jsonl_path', 'TEXT');
    addColumnToTableIfNotExists(db, 'sessions', columnNames, 'isArchived', 'BOOLEAN DEFAULT 0');
    addColumnToTableIfNotExists(db, 'sessions', columnNames, 'created_at', 'DATETIME');
    addColumnToTableIfNotExists(db, 'sessions', columnNames, 'updated_at', 'DATETIME');
    db.exec('UPDATE sessions SET isArchived = COALESCE(isArchived, 0)');
    db.exec('UPDATE sessions SET created_at = COALESCE(created_at, CURRENT_TIMESTAMP)');
    db.exec('UPDATE sessions SET updated_at = COALESCE(updated_at, CURRENT_TIMESTAMP)');
    return;
  }

  console.log('Running migration: Rebuilding sessions table to project-based schema');

  const projectPathExpression = columnNames.includes('project_path')
    ? 'project_path'
    : columnNames.includes('workspace_path')
      ? 'workspace_path'
      : 'NULL';

  const providerExpression = columnNames.includes('provider')
    ? "COALESCE(provider, 'claude')"
    : "'claude'";

  const customNameExpression = columnNames.includes('custom_name')
    ? 'custom_name'
    : 'NULL';

  const jsonlPathExpression = columnNames.includes('jsonl_path')
    ? 'jsonl_path'
    : 'NULL';

  const isArchivedExpression = columnNames.includes('isArchived')
    ? 'COALESCE(isArchived, 0)'
    : '0';

  const createdAtExpression = columnNames.includes('created_at')
    ? 'COALESCE(created_at, CURRENT_TIMESTAMP)'
    : 'CURRENT_TIMESTAMP';

  const updatedAtExpression = columnNames.includes('updated_at')
    ? 'COALESCE(updated_at, CURRENT_TIMESTAMP)'
    : 'CURRENT_TIMESTAMP';

  db.exec('DROP TABLE IF EXISTS sessions__new');
  db.exec(`
      CREATE TABLE sessions__new (
        session_id TEXT NOT NULL,
        provider TEXT NOT NULL DEFAULT 'claude',
        custom_name TEXT,
        project_path TEXT,
        jsonl_path TEXT,
        isArchived BOOLEAN DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (session_id),
        FOREIGN KEY (project_path) REFERENCES projects(project_path)
        ON DELETE SET NULL
        ON UPDATE CASCADE
      )
    `);
  db.exec(`
      WITH source_rows AS (
        SELECT
          session_id,
          ${providerExpression} AS provider,
          ${customNameExpression} AS custom_name,
          ${projectPathExpression} AS project_path,
          ${jsonlPathExpression} AS jsonl_path,
          ${isArchivedExpression} AS isArchived,
          ${createdAtExpression} AS created_at,
          ${updatedAtExpression} AS updated_at,
          rowid AS source_rowid
        FROM sessions
        WHERE session_id IS NOT NULL AND trim(session_id) <> ''
      ),
      ranked_rows AS (
        SELECT
          session_id,
          provider,
          custom_name,
          project_path,
          jsonl_path,
          isArchived,
          created_at,
          updated_at,
          ROW_NUMBER() OVER (
            PARTITION BY session_id
            ORDER BY datetime(COALESCE(updated_at, created_at)) DESC, source_rowid DESC
          ) AS session_rank
        FROM source_rows
      )
      INSERT INTO sessions__new (
        session_id,
        provider,
        custom_name,
        project_path,
        jsonl_path,
        isArchived,
        created_at,
        updated_at
      )
      SELECT
        session_id,
        provider,
        custom_name,
        project_path,
        jsonl_path,
        isArchived,
        created_at,
        updated_at
      FROM ranked_rows
      WHERE session_rank = 1
    `);
  db.exec('DROP TABLE sessions');
  db.exec('ALTER TABLE sessions__new RENAME TO sessions');
};

/**
 * Adds the `provider_session_id` mapping column used by the session gateway.
 *
 * Rows that existed before this migration were always keyed directly by the
 * provider-native session id, so backfilling `provider_session_id` with
 * `session_id` keeps every legacy row resolvable through the new mapping.
 */
const addProviderSessionIdMapping = (db: Database): void => {
  const sessionsTableInfo = getTableInfo(db, 'sessions');
  const columnNames = sessionsTableInfo.map((column) => column.name);

  addColumnToTableIfNotExists(db, 'sessions', columnNames, 'provider_session_id', 'TEXT');
  db.exec(`
    UPDATE sessions
    SET provider_session_id = session_id
    WHERE provider_session_id IS NULL
  `);
};

const ensureProjectsForSessionPaths = (db: Database): void => {
  if (!tableExists(db, 'sessions')) {
    return;
  }

  db.exec(`
    INSERT INTO projects (project_id, project_path, custom_project_name, isStarred, isArchived)
    SELECT
      ${SQLITE_UUID_SQL},
      project_path,
      NULL,
      0,
      0
    FROM sessions
    WHERE project_path IS NOT NULL AND trim(project_path) <> ''
    ON CONFLICT(project_path) DO NOTHING
  `);
};

type Migration = {
  version: number;
  migrate: (db: Database) => void;
};

const SCHEMA_MIGRATIONS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`;


/**
 * A journaled migration is committed atomically with its version record. Existing
 * installations without the journal replay every step once; all legacy helpers
 * are intentionally idempotent, so that replay is safe.
 */
const MIGRATIONS: Migration[] = [
  {
    version: 1,
    migrate: (db) => {
      const userColumnNames = getTableInfo(db, 'users').map((column) => column.name);
      addColumnToTableIfNotExists(db, 'users', userColumnNames, 'git_name', 'TEXT');
      addColumnToTableIfNotExists(db, 'users', userColumnNames, 'git_email', 'TEXT');
      addColumnToTableIfNotExists(
        db,
        'users',
        userColumnNames,
        'has_completed_onboarding',
        'BOOLEAN DEFAULT 0'
      );
    },
  },
  {
    version: 2,
    migrate: (db) => {
      db.exec(APP_CONFIG_TABLE_SCHEMA_SQL);
      db.exec(USER_NOTIFICATION_PREFERENCES_TABLE_SCHEMA_SQL);
      db.exec(VAPID_KEYS_TABLE_SCHEMA_SQL);
      db.exec(PUSH_SUBSCRIPTIONS_TABLE_SCHEMA_SQL);
      db.exec('CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user_id ON push_subscriptions(user_id)');
    },
  },
  { version: 3, migrate: (db) => db.exec(PROJECTS_TABLE_SCHEMA_SQL) },
  { version: 4, migrate: rebuildProjectsTableWithPrimaryKeySchema },
  { version: 5, migrate: migrateLegacyWorkspaceTableIntoProjects },
  { version: 6, migrate: rebuildSessionsTableWithProjectSchema },
  { version: 7, migrate: migrateLegacySessionNames },
  { version: 8, migrate: addProviderSessionIdMapping },
  { version: 9, migrate: ensureProjectsForSessionPaths },
  {
    version: 10,
    migrate: (db) => {
      db.exec('CREATE INDEX IF NOT EXISTS idx_session_ids_lookup ON sessions(session_id)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_provider_session_id ON sessions(provider_session_id)');
      // A unique index is unsafe for existing databases, which may already contain duplicate mappings.
      db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_provider_provider_session_id ON sessions(provider, provider_session_id)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_project_path ON sessions(project_path)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_is_archived ON sessions(isArchived)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_projects_is_starred ON projects(isStarred)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_projects_is_archived ON projects(isArchived)');
    },
  },
  {
    version: 11,
    migrate: (db) => {
      db.exec('DROP INDEX IF EXISTS idx_session_names_lookup');
      db.exec('DROP INDEX IF EXISTS idx_sessions_workspace_path');
      db.exec('DROP INDEX IF EXISTS idx_workspace_original_paths_is_starred');
      db.exec('DROP INDEX IF EXISTS idx_workspace_original_paths_workspace_id');

      if (tableExists(db, 'workspace_original_paths')) {
        console.log('Running migration: Dropping legacy workspace_original_paths table');
        db.exec('DROP TABLE workspace_original_paths');
      }
    },
  },
  { version: 12, migrate: (db) => db.exec(LAST_SCANNED_AT_SQL) },
  {
    version: 13,
    migrate: (db) => {
      const generationStateColumns = getTableInfo(db, 'completion_notification_generation_state')
        .map((column) => column.name);
      if (generationStateColumns.length > 0) {
        addColumnToTableIfNotExists(
          db,
          'completion_notification_generation_state',
          generationStateColumns,
          'pane_evidence_key',
          'TEXT',
        );
        addColumnToTableIfNotExists(
          db,
          'completion_notification_generation_state',
          generationStateColumns,
          'last_seen_at',
          'INTEGER CHECK (last_seen_at IS NULL OR last_seen_at >= 0)',
        );
      }
      db.exec(COMPLETION_NOTIFICATION_SCHEMA_SQL);
      db.exec(USER_NOTIFICATION_PREFERENCES_LIVE_STOP_LATCH_SQL);
      db.exec(`UPDATE user_notification_preferences
        SET preferences_json = json_set(
          CASE json_type(preferences_json, '$.events')
            WHEN 'object' THEN preferences_json
            ELSE json_set(preferences_json, '$.events', json_object())
          END,
          '$.events.liveStop', json('false')
        )
        WHERE json_valid(preferences_json)
          AND json_extract(preferences_json, '$.events.liveStop') IS NOT 0`);
      db.exec(COMPLETION_NOTIFICATION_GENERATION_STATE_STALE_INDEX_SQL);
      db.exec(`
        INSERT INTO completion_notification_policy (
          user_id, desired_web_push, consent_configured, enforcement_enabled
        )
        SELECT id, 0, 0, 1 FROM users WHERE true
        ON CONFLICT(user_id) DO NOTHING;
      `);
    },
  },
  {
    version: 14,
    migrate: (db) => {
      activateArchivedRows(db, 'sessions');
      activateArchivedRows(db, 'projects');
      db.exec('DROP INDEX IF EXISTS idx_sessions_is_archived');
      db.exec('DROP INDEX IF EXISTS idx_projects_is_archived');
      removeArchiveColumn(db, 'sessions');
      removeArchiveColumn(db, 'projects');
    },
  },
  {
    version: 15,
    migrate: (db) => {
      db.exec('DROP TABLE IF EXISTS api_keys');
      db.exec('DROP TABLE IF EXISTS user_credentials');
    },
  },
  {
    version: 16,
    migrate: (db) => {
      if (!tableExists(db, 'completion_notification_outbox')) return;
      db.exec(`CREATE INDEX IF NOT EXISTS idx_completion_notification_outbox_decision_key
        ON completion_notification_outbox(decision_key, user_id, id)`);
    },
  },
];

export const runMigrations = (db: Database) => {
  try {
    db.exec(SCHEMA_MIGRATIONS_TABLE_SQL);
    const appliedVersions = db
      .prepare('SELECT version FROM schema_migrations')
      .all() as { version: number }[];
    const appliedVersionSet = new Set(appliedVersions.map(({ version }) => version));

    for (const migration of MIGRATIONS) {
      if (appliedVersionSet.has(migration.version)) {
        continue;
      }

      db.exec('PRAGMA foreign_keys = OFF');
      try {
        db.exec('BEGIN TRANSACTION');
        migration.migrate(db);
        db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(migration.version);
        db.exec('COMMIT');
      } catch (migrationError) {
        db.exec('ROLLBACK');
        throw migrationError;
      } finally {
        db.exec('PRAGMA foreign_keys = ON');
      }
    }

    console.log('Database migrations completed successfully');
  } catch (error: any) {
    console.error('Error running migrations:', error.message);
    throw error;
  }
};
