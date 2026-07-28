const USER_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_login DATETIME,
    is_active BOOLEAN DEFAULT 1,
    git_name TEXT,
    git_email TEXT,
    has_completed_onboarding BOOLEAN DEFAULT 0
);
`;

export const API_KEYS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS api_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    key_name TEXT NOT NULL,
    api_key TEXT UNIQUE NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_used DATETIME,
    is_active BOOLEAN DEFAULT 1,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
`;

export const USER_CREDENTIALS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS user_credentials (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    credential_name TEXT NOT NULL,
    credential_type TEXT NOT NULL, -- 'github_token', 'gitlab_token', 'bitbucket_token', etc.
    credential_value TEXT NOT NULL,
    description TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    is_active BOOLEAN DEFAULT 1,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
`;

export const USER_NOTIFICATION_PREFERENCES_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS user_notification_preferences (
    user_id INTEGER PRIMARY KEY,
    preferences_json TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
`;
export const USER_NOTIFICATION_PREFERENCES_LIVE_STOP_LATCH_SQL = `
CREATE TRIGGER IF NOT EXISTS user_notification_preferences_clamp_live_stop_insert
AFTER INSERT ON user_notification_preferences
WHEN json_valid(NEW.preferences_json)
  AND json_extract(NEW.preferences_json, '$.events.liveStop') IS NOT 0
BEGIN
    UPDATE user_notification_preferences
    SET preferences_json = json_set(
      CASE json_type(preferences_json, '$.events')
        WHEN 'object' THEN preferences_json
        ELSE json_set(preferences_json, '$.events', json_object())
      END,
      '$.events.liveStop', json('false')
    )
    WHERE user_id = NEW.user_id;
END;

CREATE TRIGGER IF NOT EXISTS user_notification_preferences_clamp_live_stop_update
AFTER UPDATE OF preferences_json ON user_notification_preferences
WHEN json_valid(NEW.preferences_json)
  AND json_extract(NEW.preferences_json, '$.events.liveStop') IS NOT 0
BEGIN
    UPDATE user_notification_preferences
    SET preferences_json = json_set(
      CASE json_type(preferences_json, '$.events')
        WHEN 'object' THEN preferences_json
        ELSE json_set(preferences_json, '$.events', json_object())
      END,
      '$.events.liveStop', json('false')
    )
    WHERE user_id = NEW.user_id;
END;
`;

export const VAPID_KEYS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS vapid_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    public_key TEXT NOT NULL,
    private_key TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
`;

export const PUSH_SUBSCRIPTIONS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS push_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    endpoint TEXT NOT NULL UNIQUE,
    keys_p256dh TEXT NOT NULL,
    keys_auth TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
`;

export const PROJECTS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS projects (
    project_id TEXT PRIMARY KEY NOT NULL,
    project_path TEXT NOT NULL UNIQUE,
    custom_project_name TEXT DEFAULT NULL,
    isStarred BOOLEAN DEFAULT 0
);
`;

export const SESSIONS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT NOT NULL,
    provider TEXT NOT NULL DEFAULT 'claude',
    -- The session id used by the provider CLI/SDK on disk (JSONL file name,
    -- store.db folder, sqlite row id, ...). \`session_id\` is the stable
    -- app-facing id that the frontend uses for the whole session lifetime;
    -- \`provider_session_id\` is filled in once the provider announces its own
    -- id mid-run, or equals \`session_id\` for sessions discovered on disk.
    provider_session_id TEXT,
    custom_name TEXT,
    project_path TEXT,
    jsonl_path TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (session_id),
    FOREIGN KEY (project_path) REFERENCES projects(project_path)
    ON DELETE SET NULL
    ON UPDATE CASCADE
);
`;

export const LAST_SCANNED_AT_SQL = `
CREATE TABLE IF NOT EXISTS scan_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_scanned_at TIMESTAMP NULL
);
`;

export const APP_CONFIG_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS app_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
`;

export const COMPLETION_NOTIFICATION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS completion_notification_policy (
    user_id INTEGER PRIMARY KEY,
    desired_web_push BOOLEAN NOT NULL DEFAULT 0 CHECK (desired_web_push IN (0, 1)),
    consent_configured BOOLEAN NOT NULL DEFAULT 0 CHECK (consent_configured IN (0, 1)),
    enforcement_enabled BOOLEAN NOT NULL DEFAULT 1 CHECK (enforcement_enabled IN (0, 1)),
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS completion_notification_targets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    identity_key TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL CHECK (kind IN ('app', 'external_generation')),
    canonical_target_id INTEGER,
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (canonical_target_id) REFERENCES completion_notification_targets(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS completion_notification_aliases (
    alias TEXT PRIMARY KEY,
    target_id INTEGER NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (target_id) REFERENCES completion_notification_targets(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS completion_notification_generation_state (
    generation_target_id INTEGER PRIMARY KEY,
    high_water_seq INTEGER NOT NULL DEFAULT 0 CHECK (high_water_seq >= 0),
    armed_seq INTEGER CHECK (armed_seq IS NULL OR armed_seq > 0),
    monitor_state TEXT NOT NULL DEFAULT 'unobserved'
        CHECK (monitor_state IN ('unobserved', 'running', 'terminal')),
    last_evidence_cursor TEXT,
    pane_evidence_key TEXT,
    last_seen_at INTEGER CHECK (last_seen_at IS NULL OR last_seen_at >= 0),
    state_revision INTEGER NOT NULL DEFAULT 1 CHECK (state_revision > 0),
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (generation_target_id) REFERENCES completion_notification_targets(id) ON DELETE RESTRICT,
    CHECK (armed_seq IS NULL OR armed_seq <= high_water_seq)
);

CREATE TABLE IF NOT EXISTS completion_notification_watches (
    user_id INTEGER NOT NULL,
    target_id INTEGER NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, target_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (target_id) REFERENCES completion_notification_targets(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS completion_notification_watch_mutations (
    user_id INTEGER NOT NULL,
    mutation_id TEXT NOT NULL,
    alias TEXT NOT NULL,
    expected_revision INTEGER NOT NULL,
    watched BOOLEAN NOT NULL CHECK (watched IN (0, 1)),
    target_id INTEGER,
    result_kind TEXT NOT NULL CHECK (result_kind IN ('app', 'external_generation')),
    result_revision INTEGER NOT NULL,
    result_global_paused BOOLEAN NOT NULL CHECK (result_global_paused IN (0, 1)),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, mutation_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (target_id) REFERENCES completion_notification_targets(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS completion_notification_redirect_authorizations (
    loser_target_id INTEGER PRIMARY KEY,
    survivor_target_id INTEGER NOT NULL,
    FOREIGN KEY (loser_target_id) REFERENCES completion_notification_targets(id) ON DELETE CASCADE,
    FOREIGN KEY (survivor_target_id) REFERENCES completion_notification_targets(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS completion_notification_outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    decision_id TEXT NOT NULL UNIQUE,
    decision_key TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    event_code TEXT NOT NULL CHECK (event_code IN ('reply_ready')),
    canonical_target_id INTEGER,
    target_alias_snapshot TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    notification_tag TEXT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (canonical_target_id) REFERENCES completion_notification_targets(id) ON DELETE SET NULL,
    UNIQUE (user_id, decision_key)
);

CREATE TABLE IF NOT EXISTS completion_notification_deliveries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    outbox_id INTEGER NOT NULL,
    subscription_id INTEGER,
    subscription_id_at_creation INTEGER NOT NULL,
    endpoint_owner_id INTEGER NOT NULL,
    endpoint_snapshot TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending'
        CHECK (state IN ('pending', 'claimed', 'transient_retry', 'paused_global', 'acknowledged', 'endpoint_removed', 'permanent_failed')),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    next_due_at INTEGER NOT NULL,
    claim_token TEXT,
    claim_expires_at INTEGER,
    acknowledged_at INTEGER,
    error_class TEXT,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (outbox_id, subscription_id_at_creation),
    FOREIGN KEY (outbox_id) REFERENCES completion_notification_outbox(id) ON DELETE CASCADE,
    FOREIGN KEY (subscription_id) REFERENCES push_subscriptions(id) ON DELETE SET NULL,
    FOREIGN KEY (endpoint_owner_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_completion_notification_targets_redirect
    ON completion_notification_targets(canonical_target_id);
CREATE INDEX IF NOT EXISTS idx_completion_notification_aliases_target
    ON completion_notification_aliases(target_id);
CREATE INDEX IF NOT EXISTS idx_completion_notification_watches_target
    ON completion_notification_watches(target_id, user_id);
CREATE INDEX IF NOT EXISTS idx_completion_notification_watch_mutations_target
    ON completion_notification_watch_mutations(target_id);
CREATE INDEX IF NOT EXISTS idx_completion_notification_outbox_user_created
    ON completion_notification_outbox(user_id, created_at, id);
CREATE INDEX IF NOT EXISTS idx_completion_notification_deliveries_due
    ON completion_notification_deliveries(state, next_due_at, id);
CREATE INDEX IF NOT EXISTS idx_completion_notification_deliveries_subscription
    ON completion_notification_deliveries(subscription_id);
CREATE INDEX IF NOT EXISTS idx_completion_notification_deliveries_owner_endpoint
    ON completion_notification_deliveries(endpoint_owner_id, endpoint_snapshot);

CREATE TRIGGER IF NOT EXISTS completion_notification_targets_reject_redirect_insert
BEFORE INSERT ON completion_notification_targets
WHEN NEW.canonical_target_id IS NOT NULL
BEGIN
    SELECT RAISE(ABORT, 'completion notification redirects cannot be inserted');
END;
CREATE TRIGGER IF NOT EXISTS completion_notification_targets_reject_kind_change
BEFORE UPDATE OF kind ON completion_notification_targets
WHEN NEW.kind IS NOT OLD.kind
BEGIN
    SELECT RAISE(ABORT, 'completion notification target kind is immutable');
END;
CREATE TRIGGER IF NOT EXISTS completion_notification_targets_validate_redirect
BEFORE UPDATE OF canonical_target_id ON completion_notification_targets
WHEN NEW.canonical_target_id IS NOT OLD.canonical_target_id
BEGIN
    SELECT CASE WHEN NEW.canonical_target_id = NEW.id
        THEN RAISE(ABORT, 'completion notification redirect cycle') END;
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM completion_notification_targets
        WHERE id = NEW.canonical_target_id
          AND kind = 'app'
          AND canonical_target_id IS NULL
    ) THEN RAISE(ABORT, 'completion notification redirect must target a canonical app') END;
    SELECT CASE WHEN OLD.kind = 'app'
        AND NOT EXISTS (
            SELECT 1 FROM completion_notification_redirect_authorizations
            WHERE loser_target_id = OLD.id AND survivor_target_id = NEW.canonical_target_id
        )
        THEN RAISE(ABORT, 'app redirect requires duplicate merge authorization') END;
    SELECT CASE WHEN EXISTS (
        WITH RECURSIVE redirects(id) AS (
            SELECT NEW.canonical_target_id
            UNION ALL
            SELECT t.canonical_target_id
            FROM completion_notification_targets t
            JOIN redirects r ON t.id = r.id
            WHERE t.canonical_target_id IS NOT NULL
        )
        SELECT 1 FROM redirects WHERE id = NEW.id
    ) THEN RAISE(ABORT, 'completion notification redirect cycle') END;
END;
CREATE TRIGGER IF NOT EXISTS completion_notification_targets_consume_redirect_authorization
AFTER UPDATE OF canonical_target_id ON completion_notification_targets
WHEN OLD.kind = 'app' AND NEW.canonical_target_id IS NOT OLD.canonical_target_id
BEGIN
    DELETE FROM completion_notification_redirect_authorizations
    WHERE loser_target_id = NEW.id AND survivor_target_id = NEW.canonical_target_id;
END;
CREATE TRIGGER IF NOT EXISTS completion_notification_policy_seed_user
AFTER INSERT ON users
BEGIN
    INSERT INTO completion_notification_policy (user_id, desired_web_push, enforcement_enabled)
    VALUES (NEW.id, 0, 1)
    ON CONFLICT(user_id) DO NOTHING;
END;

`;

export const COMPLETION_NOTIFICATION_GENERATION_STATE_STALE_INDEX_SQL = `
CREATE INDEX IF NOT EXISTS idx_completion_notification_generation_state_stale
    ON completion_notification_generation_state(last_seen_at, generation_target_id);
`;

export const INIT_SCHEMA_SQL = `
-- Initialize authentication database
PRAGMA foreign_keys = ON;

${USER_TABLE_SCHEMA_SQL}
-- Indexes for performance for user lookups
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_active ON users(is_active);

${API_KEYS_TABLE_SCHEMA_SQL}
CREATE INDEX IF NOT EXISTS idx_api_keys_key ON api_keys(api_key);
CREATE INDEX IF NOT EXISTS idx_api_keys_user_id ON api_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_active ON api_keys(is_active);

${USER_CREDENTIALS_TABLE_SCHEMA_SQL}
CREATE INDEX IF NOT EXISTS idx_user_credentials_user_id ON user_credentials(user_id);
CREATE INDEX IF NOT EXISTS idx_user_credentials_type ON user_credentials(credential_type);
CREATE INDEX IF NOT EXISTS idx_user_credentials_active ON user_credentials(is_active);

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
`;
