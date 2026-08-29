import type { Database } from 'better-sqlite3';

type CountRow = Readonly<{ count: number }>;

export type FleetInstallationRole = 'standalone' | 'hub' | 'peer';

export class FleetRoleConflictDataError extends Error {
  readonly name = 'FleetRoleConflictDataError';
  readonly code = 'FLEET_ROLE_CONFLICT';

  constructor() {
    super('Fleet role conflict: revoke the inbound hub grant or remove all outbound peers, then restart ChatMux');
  }
}

export function fleetInstallationRole(db: Database): FleetInstallationRole {
  const peers = db.prepare<[], CountRow>(
    "SELECT COUNT(*) AS count FROM fleet_peers WHERE enrollment_state = 'enrolled'",
  ).get();
  const grants = db.prepare<[], CountRow>(
    "SELECT COUNT(*) AS count FROM fleet_hub_grants WHERE grant_state = 'active'",
  ).get();
  if (peers === undefined || grants === undefined) throw new FleetRoleConflictDataError();
  if (peers.count > 0 && grants.count > 0) throw new FleetRoleConflictDataError();
  if (peers.count > 0) return 'hub';
  if (grants.count > 0) return 'peer';
  return 'standalone';
}

export function assertFleetRoleIntegrity(db: Database): void {
  fleetInstallationRole(db);
}
