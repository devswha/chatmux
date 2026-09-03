import {
  APP_CONFIG_TABLE_SCHEMA_SQL,
  LAST_SCANNED_AT_SQL,
  PROJECTS_TABLE_SCHEMA_SQL,
  PUSH_SUBSCRIPTIONS_TABLE_SCHEMA_SQL,
  SESSIONS_TABLE_SCHEMA_SQL,
  USER_NOTIFICATION_PREFERENCES_LIVE_STOP_LATCH_SQL,
  USER_NOTIFICATION_PREFERENCES_TABLE_SCHEMA_SQL,
  USER_TABLE_SCHEMA_SQL,
  VAPID_KEYS_TABLE_SCHEMA_SQL,
} from '@/modules/database/schema-parts/base.js';
import {
  COMPLETION_NOTIFICATION_GENERATION_STATE_STALE_INDEX_SQL,
  COMPLETION_NOTIFICATION_SCHEMA_SQL,
} from '@/modules/database/schema-parts/completion-notifications.js';
import { FLEET_PERSISTENCE_SCHEMA_SQL, FLEET_SSH_TUNNELS_SCHEMA_SQL } from '@/modules/database/schema-parts/fleet.js';

export {
  APP_CONFIG_TABLE_SCHEMA_SQL,
  COMPLETION_NOTIFICATION_GENERATION_STATE_STALE_INDEX_SQL,
  COMPLETION_NOTIFICATION_SCHEMA_SQL,
  FLEET_PERSISTENCE_SCHEMA_SQL,
  FLEET_SSH_TUNNELS_SCHEMA_SQL,
  LAST_SCANNED_AT_SQL,
  PROJECTS_TABLE_SCHEMA_SQL,
  PUSH_SUBSCRIPTIONS_TABLE_SCHEMA_SQL,
  SESSIONS_TABLE_SCHEMA_SQL,
  USER_NOTIFICATION_PREFERENCES_LIVE_STOP_LATCH_SQL,
  USER_NOTIFICATION_PREFERENCES_TABLE_SCHEMA_SQL,
  VAPID_KEYS_TABLE_SCHEMA_SQL,
};

export const INIT_SCHEMA_SQL = `
-- Initialize authentication database
PRAGMA foreign_keys = ON;

${USER_TABLE_SCHEMA_SQL}
-- Indexes for performance for user lookups
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_active ON users(is_active);

${USER_NOTIFICATION_PREFERENCES_TABLE_SCHEMA_SQL}
${USER_NOTIFICATION_PREFERENCES_LIVE_STOP_LATCH_SQL}
CREATE INDEX IF NOT EXISTS idx_user_notification_preferences_user_id ON user_notification_preferences(user_id);

${VAPID_KEYS_TABLE_SCHEMA_SQL}

${PUSH_SUBSCRIPTIONS_TABLE_SCHEMA_SQL}
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user_id ON push_subscriptions(user_id);

${PROJECTS_TABLE_SCHEMA_SQL}
-- NOTE: These indexes are created in migrations after legacy table-shape repairs.
-- Creating them here can fail on upgraded installs where projects lacks those columns.

${SESSIONS_TABLE_SCHEMA_SQL}
CREATE INDEX IF NOT EXISTS idx_session_ids_lookup ON sessions(session_id);
-- NOTE: This index is created in migrations after sessions is rebuilt to include project_path.
-- Creating it here can fail on upgraded installs where the legacy sessions table has no project_path.

${LAST_SCANNED_AT_SQL}

${APP_CONFIG_TABLE_SCHEMA_SQL}
${COMPLETION_NOTIFICATION_SCHEMA_SQL}
${FLEET_PERSISTENCE_SCHEMA_SQL}
`;
