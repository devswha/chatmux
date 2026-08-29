import Database from 'better-sqlite3';

import type { FleetCapability } from '../../../../../shared/fleet.js';

import type { HubPeerRecord, HubPeerStatus } from './types.js';

type PeerRow = Readonly<{
  peer_id: unknown;
  url: unknown;
  transport_mode: unknown;
  pinned_public_key: unknown;
  enrollment_state: unknown;
}>;

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`invalid fleet peer ${field}`);
  return value;
}

function peer(row: PeerRow): HubPeerRecord {
  if (row.transport_mode !== 'direct-wss' && row.transport_mode !== 'ssh-loopback') {
    throw new TypeError('invalid fleet peer transport_mode');
  }
  if (row.enrollment_state !== 'enrolled' && row.enrollment_state !== 'revoked') {
    throw new TypeError('invalid fleet peer enrollment_state');
  }
  return {
    peerId: text(row.peer_id, 'peer_id'), url: text(row.url, 'url'),
    transportMode: row.transport_mode, pinnedPublicKey: text(row.pinned_public_key, 'pinned_public_key'),
    enrollmentState: row.enrollment_state,
  };
}

export class SqliteHubPeerConnectionStore {
  constructor(private readonly db: Database.Database) {}

  list(): readonly HubPeerRecord[] {
    return this.db.prepare<[], PeerRow>(`SELECT peer_id, url, transport_mode, pinned_public_key, enrollment_state
      FROM fleet_peers ORDER BY created_at_ms, peer_id`).all().map(peer);
  }

  recordNegotiation(status: HubPeerStatus, nowMs: number): void {
    if (status.protocolVersion === null || status.generation === null || status.lastHeartbeatAtMs === null) return;
    const capabilities: readonly FleetCapability[] = status.capabilities;
    this.db.prepare(`UPDATE fleet_peers SET negotiated_protocol = ?, negotiated_capabilities_json = ?,
      connection_generation = ?, last_seen_at_ms = ?, updated_at_ms = ?
      WHERE peer_id = ? AND enrollment_state = 'enrolled'`).run(
      status.protocolVersion, JSON.stringify(capabilities), status.generation,
      status.lastHeartbeatAtMs, nowMs, status.peerId,
    );
  }
}
