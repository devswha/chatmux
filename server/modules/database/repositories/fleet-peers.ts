import Database from 'better-sqlite3';

import { getConnection } from '@/modules/database/connection.js';

import { FLEET_CAPABILITIES } from '../../../../shared/fleet.js';
import type { FleetCapability } from '../../../../shared/fleet.js';

export type FleetTransportMode = 'direct-wss' | 'ssh-loopback';
export type FleetEnrollmentState = 'enrolled' | 'revoked';
export type FleetPeer = Readonly<{
  peerId: string;
  url: string;
  transportMode: FleetTransportMode;
  displayLabel: string;
  pinnedPublicKey: string;
  pinnedPublicKeyFingerprint: string;
  enrollmentState: FleetEnrollmentState;
  negotiatedProtocol: string | null;
  negotiatedCapabilities: readonly FleetCapability[];
  connectionGeneration: number;
  createdAtMs: number;
  updatedAtMs: number;
  lastSeenAtMs: number | null;
  revokedAtMs: number | null;
}>;
export type FleetPeerEnrollment = Pick<
  FleetPeer,
  'peerId' | 'url' | 'transportMode' | 'displayLabel' | 'pinnedPublicKey' | 'pinnedPublicKeyFingerprint'
>;
export type FleetPeerEnrollmentResult =
  | Readonly<{ ok: true; peer: FleetPeer }>
  | Readonly<{
    ok: false;
    reason: 'capacity' | 'role_conflict' | 'duplicate_peer_id' | 'duplicate_url' | 'duplicate_public_key' | 'duplicate_fingerprint';
  }>;
export type FleetPeerNegotiation = Readonly<{
  peerId: string;
  protocol: string;
  capabilities: readonly FleetCapability[];
  connectionGeneration: number;
  lastSeenAtMs: number;
  updatedAtMs: number;
}>;

type RawFleetPeerRow = Readonly<{
  peer_id: unknown;
  url: unknown;
  transport_mode: unknown;
  display_label: unknown;
  pinned_public_key: unknown;
  pinned_public_key_fingerprint: unknown;
  enrollment_state: unknown;
  negotiated_protocol: unknown;
  negotiated_capabilities_json: unknown;
  connection_generation: unknown;
  created_at_ms: unknown;
  updated_at_ms: unknown;
  last_seen_at_ms: unknown;
  revoked_at_ms: unknown;
}>;

type CountRow = Readonly<{ count: number }>;
type ExistingPeerRow = Readonly<{ peer_id: string; enrollment_state: string }>;

const PEER_COLUMNS = `peer_id, url, transport_mode, display_label, pinned_public_key,
  pinned_public_key_fingerprint, enrollment_state, negotiated_protocol,
  negotiated_capabilities_json, connection_generation, created_at_ms, updated_at_ms,
  last_seen_at_ms, revoked_at_ms`;

export class FleetPeerDataError extends Error {
  readonly name = 'FleetPeerDataError';
  constructor(readonly field: string) {
    super(`Malformed persisted fleet peer field: ${field}`);
  }
}

function parseString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new FleetPeerDataError(field);
  return value;
}

function parseTimestamp(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new FleetPeerDataError(field);
  }
  return value;
}

function parseNullableTimestamp(value: unknown, field: string): number | null {
  return value === null ? null : parseTimestamp(value, field);
}

function parseCapabilities(value: unknown): readonly FleetCapability[] {
  const serialized = parseString(value, 'negotiated_capabilities_json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch (error) {
    if (error instanceof SyntaxError) throw new FleetPeerDataError('negotiated_capabilities_json');
    throw error;
  }
  if (!Array.isArray(parsed)) throw new FleetPeerDataError('negotiated_capabilities_json');
  const capabilities: FleetCapability[] = [];
  for (const item of parsed) {
    const capability = FLEET_CAPABILITIES.find((candidate) => candidate === item);
    if (capability === undefined || capabilities.includes(capability)) {
      throw new FleetPeerDataError('negotiated_capabilities_json');
    }
    capabilities.push(capability);
  }
  return capabilities;
}

function parsePeer(row: RawFleetPeerRow): FleetPeer {
  const transportMode = row.transport_mode === 'direct-wss' || row.transport_mode === 'ssh-loopback'
    ? row.transport_mode
    : undefined;
  const enrollmentState = row.enrollment_state === 'enrolled' || row.enrollment_state === 'revoked'
    ? row.enrollment_state
    : undefined;
  if (transportMode === undefined) throw new FleetPeerDataError('transport_mode');
  if (enrollmentState === undefined) throw new FleetPeerDataError('enrollment_state');
  if (row.negotiated_protocol !== null && typeof row.negotiated_protocol !== 'string') {
    throw new FleetPeerDataError('negotiated_protocol');
  }
  return {
    peerId: parseString(row.peer_id, 'peer_id'),
    url: parseString(row.url, 'url'),
    transportMode,
    displayLabel: parseString(row.display_label, 'display_label'),
    pinnedPublicKey: parseString(row.pinned_public_key, 'pinned_public_key'),
    pinnedPublicKeyFingerprint: parseString(row.pinned_public_key_fingerprint, 'pinned_public_key_fingerprint'),
    enrollmentState,
    negotiatedProtocol: row.negotiated_protocol,
    negotiatedCapabilities: parseCapabilities(row.negotiated_capabilities_json),
    connectionGeneration: parseTimestamp(row.connection_generation, 'connection_generation'),
    createdAtMs: parseTimestamp(row.created_at_ms, 'created_at_ms'),
    updatedAtMs: parseTimestamp(row.updated_at_ms, 'updated_at_ms'),
    lastSeenAtMs: parseNullableTimestamp(row.last_seen_at_ms, 'last_seen_at_ms'),
    revokedAtMs: parseNullableTimestamp(row.revoked_at_ms, 'revoked_at_ms'),
  };
}

export class FleetPeersRepository {
  constructor(private readonly injectedDb?: Database.Database) {}

  private get db(): Database.Database {
    return this.injectedDb ?? getConnection();
  }

  find(peerId: string): FleetPeer | undefined {
    const row = this.db.prepare<[string], RawFleetPeerRow>(
      `SELECT ${PEER_COLUMNS} FROM fleet_peers WHERE peer_id = ?`,
    ).get(peerId);
    return row === undefined ? undefined : parsePeer(row);
  }

  list(): readonly FleetPeer[] {
    return this.db.prepare<[], RawFleetPeerRow>(
      `SELECT ${PEER_COLUMNS} FROM fleet_peers ORDER BY created_at_ms, peer_id`,
    ).all().map(parsePeer);
  }

  hasActiveInboundGrant(): boolean {
    const row = this.db.prepare<[], CountRow>(
      "SELECT COUNT(*) AS count FROM fleet_hub_grants WHERE grant_state = 'active'",
    ).get();
    if (row === undefined) throw new FleetPeerDataError('fleet_hub_grants');
    return row.count > 0;
  }

  enroll(input: FleetPeerEnrollment, now: number): FleetPeerEnrollmentResult {
    return this.db.transaction((): FleetPeerEnrollmentResult => {
      if (this.hasActiveInboundGrant()) return { ok: false, reason: 'role_conflict' };
      const existing = this.db.prepare<[string], ExistingPeerRow>(
        'SELECT peer_id, enrollment_state FROM fleet_peers WHERE peer_id = ?',
      ).get(input.peerId);
      if (existing?.enrollment_state === 'enrolled') return { ok: false, reason: 'duplicate_peer_id' };
      const conflicts = [
        ['url', input.url, 'duplicate_url'],
        ['pinned_public_key', input.pinnedPublicKey, 'duplicate_public_key'],
        ['pinned_public_key_fingerprint', input.pinnedPublicKeyFingerprint, 'duplicate_fingerprint'],
      ] as const;
      for (const [column, value, reason] of conflicts) {
        const conflict = this.db.prepare<[string, string], Readonly<{ peer_id: string }>>(
          `SELECT peer_id FROM fleet_peers WHERE ${column} = ? AND peer_id <> ?`,
        ).get(value, input.peerId);
        if (conflict !== undefined) return { ok: false, reason };
      }
      const count = this.db.prepare<[], CountRow>(
        "SELECT COUNT(*) AS count FROM fleet_peers WHERE enrollment_state = 'enrolled'",
      ).get();
      if (count === undefined || count.count >= 9) return { ok: false, reason: 'capacity' };
      if (existing === undefined) {
        this.db.prepare(`INSERT INTO fleet_peers (
          peer_id, url, transport_mode, display_label, pinned_public_key,
          pinned_public_key_fingerprint, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
          input.peerId, input.url, input.transportMode, input.displayLabel, input.pinnedPublicKey,
          input.pinnedPublicKeyFingerprint, now, now,
        );
      } else {
        this.db.prepare(`UPDATE fleet_peers SET
          url = ?, transport_mode = ?, display_label = ?, pinned_public_key = ?,
          pinned_public_key_fingerprint = ?, enrollment_state = 'enrolled',
          negotiated_protocol = NULL, negotiated_capabilities_json = '[]',
          connection_generation = 0, updated_at_ms = ?, last_seen_at_ms = NULL, revoked_at_ms = NULL
          WHERE peer_id = ?`).run(
          input.url, input.transportMode, input.displayLabel, input.pinnedPublicKey,
          input.pinnedPublicKeyFingerprint, now, input.peerId,
        );
      }
      const peer = this.find(input.peerId);
      if (peer === undefined) throw new FleetPeerDataError('peer_id');
      return { ok: true, peer };
    })();
  }

  recordNegotiation(negotiation: FleetPeerNegotiation): FleetPeer | undefined {
    this.db.prepare(`UPDATE fleet_peers SET negotiated_protocol = ?,
      negotiated_capabilities_json = ?, connection_generation = ?, last_seen_at_ms = ?, updated_at_ms = ?
      WHERE peer_id = ? AND enrollment_state = 'enrolled'`).run(
      negotiation.protocol,
      JSON.stringify(negotiation.capabilities),
      negotiation.connectionGeneration,
      negotiation.lastSeenAtMs,
      negotiation.updatedAtMs,
      negotiation.peerId,
    );
    return this.find(negotiation.peerId);
  }

  revoke(peerId: string, now: number): FleetPeer | undefined {
    return this.db.transaction(() => {
      this.db.prepare(`UPDATE fleet_hub_grants SET grant_state = 'revoked', revoked_at_ms = ?, updated_at_ms = ?
        WHERE peer_id = ? AND grant_state = 'active'`).run(now, now, peerId);
      this.db.prepare(`UPDATE fleet_peers SET enrollment_state = 'revoked', revoked_at_ms = ?, updated_at_ms = ?
        WHERE peer_id = ? AND enrollment_state = 'enrolled'`).run(now, now, peerId);
      return this.find(peerId);
    })();
  }

  removeRevoked(peerId: string): 'removed' | 'not_found' | 'peer_active' {
    return this.db.transaction(() => {
      const peer = this.find(peerId);
      if (peer === undefined) return 'not_found';
      if (peer.enrollmentState === 'enrolled') return 'peer_active';
      this.db.prepare('DELETE FROM fleet_hub_grants WHERE peer_id = ?').run(peerId);
      this.db.prepare("DELETE FROM fleet_peers WHERE peer_id = ? AND enrollment_state = 'revoked'").run(peerId);
      return 'removed';
    })();
  }
}

export const fleetPeersDb = new FleetPeersRepository();
