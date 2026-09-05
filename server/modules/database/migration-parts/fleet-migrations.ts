import type { Database } from 'better-sqlite3';

import { tableExists } from '@/modules/database/migration-parts/database-inspection.js';
import { assertFleetRoleIntegrity } from '@/modules/database/repositories/fleet-installation-role.js';

type ForeignKeyRow = Readonly<{ readonly table: string }>;

/**
 * Migration 17 shipped fleet_hub_grants with a foreign key into fleet_peers.
 * That table is the peer-side hub-grant record: peer_id is the LOCAL
 * installation ID, which never appears in the local fleet_peers registry (a
 * hub-only table), so redemption on a real peer always violated the key.
 * Rebuild the table without the reference, preserving every pinned grant.
 */
export const FLEET_ROLE_EXCLUSIVITY_TRIGGERS_SQL = `
  CREATE TRIGGER IF NOT EXISTS fleet_role_peer_insert
  BEFORE INSERT ON fleet_peers
  WHEN NEW.enrollment_state = 'enrolled'
    AND EXISTS (SELECT 1 FROM fleet_hub_grants WHERE grant_state = 'active')
  BEGIN SELECT RAISE(ABORT, 'fleet role conflict: active inbound hub grant'); END;

  CREATE TRIGGER IF NOT EXISTS fleet_role_peer_update
  BEFORE UPDATE OF enrollment_state ON fleet_peers
  WHEN OLD.enrollment_state <> 'enrolled' AND NEW.enrollment_state = 'enrolled'
    AND EXISTS (SELECT 1 FROM fleet_hub_grants WHERE grant_state = 'active')
  BEGIN SELECT RAISE(ABORT, 'fleet role conflict: active inbound hub grant'); END;

  CREATE TRIGGER IF NOT EXISTS fleet_role_grant_insert
  BEFORE INSERT ON fleet_hub_grants
  WHEN NEW.grant_state = 'active'
    AND EXISTS (SELECT 1 FROM fleet_peers WHERE enrollment_state = 'enrolled')
  BEGIN SELECT RAISE(ABORT, 'fleet role conflict: enrolled outbound peer'); END;

  CREATE TRIGGER IF NOT EXISTS fleet_role_grant_update
  BEFORE UPDATE OF grant_state ON fleet_hub_grants
  WHEN OLD.grant_state <> 'active' AND NEW.grant_state = 'active'
    AND EXISTS (SELECT 1 FROM fleet_peers WHERE enrollment_state = 'enrolled')
  BEGIN SELECT RAISE(ABORT, 'fleet role conflict: enrolled outbound peer'); END;
`;

export function enforceFleetRoleExclusivity(db: Database): void {
  assertFleetRoleIntegrity(db);
  db.exec(FLEET_ROLE_EXCLUSIVITY_TRIGGERS_SQL);
}

export const rebuildFleetHubGrantsWithoutRegistryReference = (db: Database): void => {
  if (!tableExists(db, 'fleet_hub_grants')) return;
  const references = db.pragma('foreign_key_list(fleet_hub_grants)') as readonly ForeignKeyRow[];
  if (!references.some(({ table }) => table === 'fleet_peers')) return;

  console.error('Running migration: Rebuilding fleet_hub_grants without the fleet_peers reference');
  db.exec(`
    DROP TRIGGER IF EXISTS fleet_role_peer_insert;
    DROP TRIGGER IF EXISTS fleet_role_peer_update;
    DROP TRIGGER IF EXISTS fleet_role_grant_insert;
    DROP TRIGGER IF EXISTS fleet_role_grant_update;
    CREATE TABLE fleet_hub_grants_migrated (
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
    INSERT INTO fleet_hub_grants_migrated (
      grant_id, peer_id, hub_installation_id, pinned_public_key, pinned_public_key_fingerprint,
      grant_state, created_at_ms, updated_at_ms, revoked_at_ms
    )
    SELECT
      grant_id, peer_id, hub_installation_id, pinned_public_key, pinned_public_key_fingerprint,
      grant_state, created_at_ms, updated_at_ms, revoked_at_ms
    FROM fleet_hub_grants;
    DROP TABLE fleet_hub_grants;
    ALTER TABLE fleet_hub_grants_migrated RENAME TO fleet_hub_grants;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_fleet_hub_grants_one_active_peer
      ON fleet_hub_grants(peer_id) WHERE grant_state = 'active';
    CREATE INDEX IF NOT EXISTS idx_fleet_hub_grants_hub
      ON fleet_hub_grants(hub_installation_id, grant_state);
  `);
  db.exec(FLEET_ROLE_EXCLUSIVITY_TRIGGERS_SQL);
};
