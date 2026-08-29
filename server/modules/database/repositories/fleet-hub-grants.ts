import Database from 'better-sqlite3';

import { getConnection } from '@/modules/database/connection.js';

export type FleetHubGrantState = 'active' | 'revoked';
export type FleetHubGrant = Readonly<{
  grantId: number;
  peerId: string;
  hubInstallationId: string;
  pinnedPublicKey: string;
  pinnedPublicKeyFingerprint: string;
  grantState: FleetHubGrantState;
  createdAtMs: number;
  updatedAtMs: number;
  revokedAtMs: number | null;
}>;
export type FleetHubGrantInput = Pick<
  FleetHubGrant,
  'peerId' | 'hubInstallationId' | 'pinnedPublicKey' | 'pinnedPublicKeyFingerprint'
>;
export type FleetHubGrantCreateResult =
  | Readonly<{ ok: true; grant: FleetHubGrant }>
  | Readonly<{ ok: false; reason: 'active_grant_exists' | 'role_conflict' }>;

type GrantRow = Readonly<{
  grant_id: unknown;
  peer_id: unknown;
  hub_installation_id: unknown;
  pinned_public_key: unknown;
  pinned_public_key_fingerprint: unknown;
  grant_state: unknown;
  created_at_ms: unknown;
  updated_at_ms: unknown;
  revoked_at_ms: unknown;
}>;
type CountRow = Readonly<{ count: number }>;
type ActiveGrantRow = Readonly<{ grant_id: number }>;

const GRANT_COLUMNS = `grant_id, peer_id, hub_installation_id, pinned_public_key,
  pinned_public_key_fingerprint, grant_state, created_at_ms, updated_at_ms, revoked_at_ms`;

export class FleetHubGrantDataError extends Error {
  readonly name = 'FleetHubGrantDataError';
  constructor(readonly field: string) {
    super(`Malformed persisted fleet hub grant field: ${field}`);
  }
}

function grantString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new FleetHubGrantDataError(field);
  return value;
}

function grantTimestamp(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new FleetHubGrantDataError(field);
  }
  return value;
}

function mapGrant(row: GrantRow): FleetHubGrant {
  const grantState = row.grant_state === 'active' || row.grant_state === 'revoked'
    ? row.grant_state
    : undefined;
  if (grantState === undefined) throw new FleetHubGrantDataError('grant_state');
  if (row.revoked_at_ms !== null && (typeof row.revoked_at_ms !== 'number'
    || !Number.isSafeInteger(row.revoked_at_ms) || row.revoked_at_ms < 0)) {
    throw new FleetHubGrantDataError('revoked_at_ms');
  }
  return {
    grantId: grantTimestamp(row.grant_id, 'grant_id'),
    peerId: grantString(row.peer_id, 'peer_id'),
    hubInstallationId: grantString(row.hub_installation_id, 'hub_installation_id'),
    pinnedPublicKey: grantString(row.pinned_public_key, 'pinned_public_key'),
    pinnedPublicKeyFingerprint: grantString(row.pinned_public_key_fingerprint, 'pinned_public_key_fingerprint'),
    grantState,
    createdAtMs: grantTimestamp(row.created_at_ms, 'created_at_ms'),
    updatedAtMs: grantTimestamp(row.updated_at_ms, 'updated_at_ms'),
    revokedAtMs: row.revoked_at_ms,
  };
}

export class FleetHubGrantsRepository {
  constructor(private readonly injectedDb?: Database.Database) {}

  private get db(): Database.Database {
    return this.injectedDb ?? getConnection();
  }

  create(input: FleetHubGrantInput, now: number): FleetHubGrantCreateResult {
    return this.db.transaction((): FleetHubGrantCreateResult => {
      const peers = this.db.prepare<[], CountRow>(
        "SELECT COUNT(*) AS count FROM fleet_peers WHERE enrollment_state = 'enrolled'",
      ).get();
      if (peers === undefined || peers.count > 0) return { ok: false, reason: 'role_conflict' };
      const active = this.db.prepare<[string], ActiveGrantRow>(
        "SELECT grant_id FROM fleet_hub_grants WHERE peer_id = ? AND grant_state = 'active'",
      ).get(input.peerId);
      if (active !== undefined) return { ok: false, reason: 'active_grant_exists' };
      const result = this.db.prepare(`INSERT INTO fleet_hub_grants (
        peer_id, hub_installation_id, pinned_public_key, pinned_public_key_fingerprint,
        created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?)`).run(
        input.peerId,
        input.hubInstallationId,
        input.pinnedPublicKey,
        input.pinnedPublicKeyFingerprint,
        now,
        now,
      );
      const row = this.db.prepare<[number], GrantRow>(
        `SELECT ${GRANT_COLUMNS} FROM fleet_hub_grants WHERE grant_id = ?`,
      ).get(Number(result.lastInsertRowid));
      if (row === undefined) throw new TypeError('inserted fleet hub grant is missing');
      return { ok: true, grant: mapGrant(row) };
    })();
  }

  revokeActive(peerId: string, now: number): FleetHubGrant | undefined {
    const active = this.db.prepare<[string], ActiveGrantRow>(
      "SELECT grant_id FROM fleet_hub_grants WHERE peer_id = ? AND grant_state = 'active'",
    ).get(peerId);
    if (active === undefined) return undefined;
    this.db.prepare(`UPDATE fleet_hub_grants SET grant_state = 'revoked', revoked_at_ms = ?, updated_at_ms = ?
      WHERE grant_id = ?`).run(now, now, active.grant_id);
    const row = this.db.prepare<[number], GrantRow>(
      `SELECT ${GRANT_COLUMNS} FROM fleet_hub_grants WHERE grant_id = ?`,
    ).get(active.grant_id);
    return row === undefined ? undefined : mapGrant(row);
  }

  listForPeer(peerId: string): readonly FleetHubGrant[] {
    return this.db.prepare<[string], GrantRow>(
      `SELECT ${GRANT_COLUMNS} FROM fleet_hub_grants WHERE peer_id = ? ORDER BY grant_id`,
    ).all(peerId).map(mapGrant);
  }

  list(): readonly FleetHubGrant[] {
    return this.db.prepare<[], GrantRow>(
      `SELECT ${GRANT_COLUMNS} FROM fleet_hub_grants ORDER BY created_at_ms, grant_id`,
    ).all().map(mapGrant);
  }

  revokeActiveHub(hubInstallationId: string, now: number): FleetHubGrant | undefined {
    const row = this.db.prepare<[string], ActiveGrantRow>(
      "SELECT grant_id FROM fleet_hub_grants WHERE hub_installation_id = ? AND grant_state = 'active'",
    ).get(hubInstallationId);
    if (row === undefined) return undefined;
    this.db.prepare(`UPDATE fleet_hub_grants SET grant_state = 'revoked', revoked_at_ms = ?, updated_at_ms = ?
      WHERE grant_id = ?`).run(now, now, row.grant_id);
    const revoked = this.db.prepare<[number], GrantRow>(
      `SELECT ${GRANT_COLUMNS} FROM fleet_hub_grants WHERE grant_id = ?`,
    ).get(row.grant_id);
    return revoked === undefined ? undefined : mapGrant(revoked);
  }
}

export const fleetHubGrantsDb = new FleetHubGrantsRepository();
