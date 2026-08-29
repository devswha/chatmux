import Database from 'better-sqlite3';

import { FleetPairingTokensRepository } from '@/modules/database/index.js';
import type { AtomicPairingStore, HubGrantPin, PairingStoreResult } from '@/modules/fleet/services/fleet-pairing.service.js';

type CountRow = Readonly<{ count: number }>;

export class SqliteFleetPairingStore implements AtomicPairingStore {
  private readonly tokens: FleetPairingTokensRepository;

  constructor(private readonly db: Database.Database) {
    this.tokens = new FleetPairingTokensRepository(db);
  }

  issue(token: Uint8Array, expiresAtMs: number, nowMs: number): void {
    this.tokens.issue(token, expiresAtMs, nowMs);
  }

  consumeAndPin(token: Uint8Array, grant: HubGrantPin, nowMs: number): PairingStoreResult {
    return this.db.transaction((): PairingStoreResult => {
      const enrolledPeers = this.db.prepare<[], CountRow>(`SELECT COUNT(*) AS count
        FROM fleet_peers WHERE enrollment_state = 'enrolled'`).get();
      if (enrolledPeers === undefined) throw new TypeError('enrolled fleet peer count is missing');
      if (enrolledPeers.count > 0) return { kind: 'role_conflict' };
      const active = this.db.prepare<[string], CountRow>(`SELECT COUNT(*) AS count
        FROM fleet_hub_grants WHERE peer_id = ? AND grant_state = 'active'`).get(grant.peerId);
      if (active === undefined) throw new TypeError('active fleet grant count is missing');
      if (active.count > 0) {
        const inspected = this.tokens.inspect(token, nowMs);
        switch (inspected.kind) {
          case 'not_found': return { kind: 'not_found' };
          case 'expired': return { kind: 'expired' };
          case 'already_consumed': return { kind: 'already_consumed' };
          case 'available': return { kind: 'active_grant_exists' };
          default: {
            const exhaustive: never = inspected;
            return exhaustive;
          }
        }
      }
      const consumed = this.tokens.consume(token, nowMs);
      switch (consumed.kind) {
        case 'not_found': return { kind: 'not_found' };
        case 'expired': return { kind: 'expired' };
        case 'already_consumed': return { kind: 'already_consumed' };
        case 'consumed': break;
        default: {
          const exhaustive: never = consumed;
          return exhaustive;
        }
      }
      this.db.prepare(`INSERT INTO fleet_hub_grants (
        peer_id, hub_installation_id, pinned_public_key, pinned_public_key_fingerprint,
        created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?)`).run(
        grant.peerId,
        grant.hubInstallationId,
        grant.pinnedPublicKey,
        grant.pinnedPublicKeyFingerprint,
        nowMs,
        nowMs,
      );
      return { kind: 'enrolled' };
    })();
  }

  revoke(peerId: string, nowMs: number): boolean {
    return this.db.prepare(`UPDATE fleet_hub_grants SET grant_state = 'revoked',
      revoked_at_ms = ?, updated_at_ms = ? WHERE peer_id = ? AND grant_state = 'active'`)
      .run(nowMs, nowMs, peerId).changes === 1;
  }

  revokeAuthorized(
    peerId: string,
    hubInstallationId: string,
    pinnedPublicKey: string,
    nowMs: number,
  ): boolean {
    return this.db.prepare(`UPDATE fleet_hub_grants SET grant_state = 'revoked',
      revoked_at_ms = ?, updated_at_ms = ? WHERE peer_id = ? AND hub_installation_id = ?
      AND pinned_public_key = ? AND grant_state = 'active'`)
      .run(nowMs, nowMs, peerId, hubInstallationId, pinnedPublicKey).changes === 1;
  }
}
