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
CREATE INDEX IF NOT EXISTS idx_completion_notification_outbox_decision_key
    ON completion_notification_outbox(decision_key, user_id, id);
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

