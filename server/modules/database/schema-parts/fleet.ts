export const FLEET_SSH_TUNNELS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS fleet_ssh_tunnels (
    peer_id TEXT PRIMARY KEY NOT NULL REFERENCES fleet_peers(peer_id) ON DELETE CASCADE,
    ssh_target TEXT NOT NULL UNIQUE CHECK (length(ssh_target) > 0),
    ssh_port INTEGER CHECK (ssh_port BETWEEN 1 AND 65535),
    local_port INTEGER NOT NULL UNIQUE CHECK (local_port BETWEEN 1 AND 65535),
    control_path TEXT NOT NULL CHECK (length(control_path) > 0)
);
`;

export const FLEET_PERSISTENCE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS fleet_peers (
    peer_id TEXT PRIMARY KEY NOT NULL,
    url TEXT NOT NULL UNIQUE CHECK (length(url) > 0),
    transport_mode TEXT NOT NULL CHECK (transport_mode IN ('direct-wss', 'ssh-loopback')),
    display_label TEXT NOT NULL CHECK (length(display_label) > 0),
    pinned_public_key TEXT NOT NULL UNIQUE CHECK (length(pinned_public_key) > 0),
    pinned_public_key_fingerprint TEXT NOT NULL UNIQUE
        CHECK (length(pinned_public_key_fingerprint) > 0),
    enrollment_state TEXT NOT NULL DEFAULT 'enrolled'
        CHECK (enrollment_state IN ('enrolled', 'revoked')),
    negotiated_protocol TEXT,
    negotiated_capabilities_json TEXT NOT NULL DEFAULT '[]'
        CHECK (
            json_valid(negotiated_capabilities_json)
            AND json_type(negotiated_capabilities_json) = 'array'
        ),
    connection_generation INTEGER NOT NULL DEFAULT 0
        CHECK (connection_generation BETWEEN 0 AND 9007199254740991),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms BETWEEN 0 AND 9007199254740991),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms BETWEEN 0 AND 9007199254740991),
    last_seen_at_ms INTEGER CHECK (last_seen_at_ms BETWEEN 0 AND 9007199254740991),
    revoked_at_ms INTEGER CHECK (revoked_at_ms BETWEEN 0 AND 9007199254740991),
    CHECK (
        (enrollment_state = 'enrolled' AND revoked_at_ms IS NULL)
        OR (enrollment_state = 'revoked' AND revoked_at_ms IS NOT NULL)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_fleet_peers_url ON fleet_peers(url);
CREATE INDEX IF NOT EXISTS idx_fleet_peers_state ON fleet_peers(enrollment_state, peer_id);

${FLEET_SSH_TUNNELS_SCHEMA_SQL}

CREATE TRIGGER IF NOT EXISTS fleet_peers_limit_enrolled_insert
BEFORE INSERT ON fleet_peers
WHEN NEW.enrollment_state = 'enrolled'
  AND (SELECT COUNT(*) FROM fleet_peers WHERE enrollment_state = 'enrolled') >= 9
BEGIN
    SELECT RAISE(ABORT, 'fleet remote peer capacity exceeded');
END;

CREATE TRIGGER IF NOT EXISTS fleet_peers_limit_enrolled_update
BEFORE UPDATE OF enrollment_state ON fleet_peers
WHEN OLD.enrollment_state <> 'enrolled'
  AND NEW.enrollment_state = 'enrolled'
  AND (SELECT COUNT(*) FROM fleet_peers WHERE enrollment_state = 'enrolled') >= 9
BEGIN
    SELECT RAISE(ABORT, 'fleet remote peer capacity exceeded');
END;

CREATE TABLE IF NOT EXISTS fleet_hub_grants (
    grant_id INTEGER PRIMARY KEY AUTOINCREMENT,
    peer_id TEXT NOT NULL,
    hub_installation_id TEXT NOT NULL CHECK (length(hub_installation_id) > 0),
    pinned_public_key TEXT NOT NULL CHECK (length(pinned_public_key) > 0),
    pinned_public_key_fingerprint TEXT NOT NULL
        CHECK (length(pinned_public_key_fingerprint) > 0),
    grant_state TEXT NOT NULL DEFAULT 'active' CHECK (grant_state IN ('active', 'revoked')),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms BETWEEN 0 AND 9007199254740991),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms BETWEEN 0 AND 9007199254740991),
    revoked_at_ms INTEGER CHECK (revoked_at_ms BETWEEN 0 AND 9007199254740991),
    CHECK (
        (grant_state = 'active' AND revoked_at_ms IS NULL)
        OR (grant_state = 'revoked' AND revoked_at_ms IS NOT NULL)
    )
);
-- fleet_hub_grants lives on the peer installation and peer_id is the LOCAL
-- installation ID, which never appears in the local fleet_peers registry (that
-- registry lists a hub's remote peers). A foreign key into fleet_peers is
-- therefore unsatisfiable on a real peer and was retired by migration 18.

CREATE UNIQUE INDEX IF NOT EXISTS idx_fleet_hub_grants_one_active_peer
    ON fleet_hub_grants(peer_id) WHERE grant_state = 'active';
CREATE INDEX IF NOT EXISTS idx_fleet_hub_grants_hub
    ON fleet_hub_grants(hub_installation_id, grant_state);

CREATE TRIGGER IF NOT EXISTS fleet_role_peer_insert
BEFORE INSERT ON fleet_peers
WHEN NEW.enrollment_state = 'enrolled'
  AND EXISTS (SELECT 1 FROM fleet_hub_grants WHERE grant_state = 'active')
BEGIN
    SELECT RAISE(ABORT, 'fleet role conflict: active inbound hub grant');
END;

CREATE TRIGGER IF NOT EXISTS fleet_role_peer_update
BEFORE UPDATE OF enrollment_state ON fleet_peers
WHEN OLD.enrollment_state <> 'enrolled' AND NEW.enrollment_state = 'enrolled'
  AND EXISTS (SELECT 1 FROM fleet_hub_grants WHERE grant_state = 'active')
BEGIN
    SELECT RAISE(ABORT, 'fleet role conflict: active inbound hub grant');
END;

CREATE TRIGGER IF NOT EXISTS fleet_role_grant_insert
BEFORE INSERT ON fleet_hub_grants
WHEN NEW.grant_state = 'active'
  AND EXISTS (SELECT 1 FROM fleet_peers WHERE enrollment_state = 'enrolled')
BEGIN
    SELECT RAISE(ABORT, 'fleet role conflict: enrolled outbound peer');
END;

CREATE TRIGGER IF NOT EXISTS fleet_role_grant_update
BEFORE UPDATE OF grant_state ON fleet_hub_grants
WHEN OLD.grant_state <> 'active' AND NEW.grant_state = 'active'
  AND EXISTS (SELECT 1 FROM fleet_peers WHERE enrollment_state = 'enrolled')
BEGIN
    SELECT RAISE(ABORT, 'fleet role conflict: enrolled outbound peer');
END;

CREATE TABLE IF NOT EXISTS fleet_pairing_tokens (
    token_hash TEXT PRIMARY KEY NOT NULL
        CHECK (length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms BETWEEN 0 AND 9007199254740991),
    expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms BETWEEN 0 AND 9007199254740991),
    consumed_at_ms INTEGER CHECK (consumed_at_ms BETWEEN 0 AND 9007199254740991),
    CHECK (expires_at_ms > created_at_ms),
    CHECK (consumed_at_ms IS NULL OR consumed_at_ms >= created_at_ms)
);

CREATE INDEX IF NOT EXISTS idx_fleet_pairing_tokens_expiry
    ON fleet_pairing_tokens(expires_at_ms, consumed_at_ms);
`;

