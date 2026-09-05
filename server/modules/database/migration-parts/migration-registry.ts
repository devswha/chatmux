import type { Database } from 'better-sqlite3';

import {
  activateArchivedRows,
  addColumnToTableIfNotExists,
  getTableInfo,
  removeArchiveColumn,
  tableExists,
} from '@/modules/database/migration-parts/database-inspection.js';
import {
  enforceFleetRoleExclusivity,
  rebuildFleetHubGrantsWithoutRegistryReference,
} from '@/modules/database/migration-parts/fleet-migrations.js';
import {
  ensureProjectsForSessionPaths,
  migrateLegacyWorkspaceTableIntoProjects,
  rebuildProjectsTableWithPrimaryKeySchema,
} from '@/modules/database/migration-parts/project-migrations.js';
import {
  addProviderSessionIdMapping,
  migrateLegacySessionNames,
  rebuildSessionsTableWithProjectSchema,
} from '@/modules/database/migration-parts/session-migrations.js';
import {
  APP_CONFIG_TABLE_SCHEMA_SQL,
  COMPLETION_NOTIFICATION_GENERATION_STATE_STALE_INDEX_SQL,
  COMPLETION_NOTIFICATION_SCHEMA_SQL,
  FLEET_PERSISTENCE_SCHEMA_SQL,
  FLEET_SSH_TUNNELS_SCHEMA_SQL,
  LAST_SCANNED_AT_SQL,
  PROJECTS_TABLE_SCHEMA_SQL,
  PUSH_SUBSCRIPTIONS_TABLE_SCHEMA_SQL,
  USER_NOTIFICATION_PREFERENCES_LIVE_STOP_LATCH_SQL,
  USER_NOTIFICATION_PREFERENCES_TABLE_SCHEMA_SQL,
  VAPID_KEYS_TABLE_SCHEMA_SQL,
} from '@/modules/database/schema.js';

export type Migration = {
  version: number;
  migrate: (db: Database) => void;
};

export const SCHEMA_MIGRATIONS_TABLE_SQL = `
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
export const MIGRATIONS: Migration[] = [
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
        console.error('Running migration: Dropping legacy workspace_original_paths table');
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
  { version: 17, migrate: (db) => db.exec(FLEET_PERSISTENCE_SCHEMA_SQL) },
  { version: 18, migrate: rebuildFleetHubGrantsWithoutRegistryReference },
  { version: 19, migrate: enforceFleetRoleExclusivity },
  { version: 20, migrate: (db) => db.exec(FLEET_SSH_TUNNELS_SCHEMA_SQL) },
];

