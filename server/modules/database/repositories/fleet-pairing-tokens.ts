import { createHash } from 'node:crypto';

import Database from 'better-sqlite3';

import { getConnection } from '@/modules/database/connection.js';

export type FleetPairingToken = Readonly<{
  tokenHash: string;
  createdAtMs: number;
  expiresAtMs: number;
  consumedAtMs: number | null;
}>;
export type FleetPairingTokenConsumeResult =
  | Readonly<{ kind: 'consumed' }>
  | Readonly<{ kind: 'not_found' }>
  | Readonly<{ kind: 'expired' }>
  | Readonly<{ kind: 'already_consumed' }>;
export type FleetPairingTokenInspectionResult =
  | Readonly<{ kind: 'available' }>
  | Exclude<FleetPairingTokenConsumeResult, Readonly<{ kind: 'consumed' }>>;

type TokenRow = Readonly<{
  token_hash: unknown;
  created_at_ms: unknown;
  expires_at_ms: unknown;
  consumed_at_ms: unknown;
}>;

export class FleetPairingTokenDataError extends Error {
  readonly name = 'FleetPairingTokenDataError';
  constructor(readonly field: string) {
    super(`Malformed persisted fleet pairing token field: ${field}`);
  }
}

export class FleetPairingTokenInputError extends Error {
  readonly name = 'FleetPairingTokenInputError';
  constructor(readonly field: 'token' | 'expiresAtMs') {
    super(`Invalid fleet pairing token ${field}`);
  }
}

function tokenHash(token: Uint8Array): string {
  if (token.byteLength !== 32) throw new FleetPairingTokenInputError('token');
  return createHash('sha256').update(token).digest('hex');
}

function persistedTimestamp(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new FleetPairingTokenDataError(field);
  }
  return value;
}

function mapToken(row: TokenRow): FleetPairingToken {
  if (typeof row.token_hash !== 'string' || !/^[0-9a-f]{64}$/.test(row.token_hash)) {
    throw new FleetPairingTokenDataError('token_hash');
  }
  const consumedAtMs = row.consumed_at_ms === null
    ? null
    : persistedTimestamp(row.consumed_at_ms, 'consumed_at_ms');
  return {
    tokenHash: row.token_hash,
    createdAtMs: persistedTimestamp(row.created_at_ms, 'created_at_ms'),
    expiresAtMs: persistedTimestamp(row.expires_at_ms, 'expires_at_ms'),
    consumedAtMs,
  };
}

export class FleetPairingTokensRepository {
  constructor(private readonly injectedDb?: Database.Database) {}

  private get db(): Database.Database {
    return this.injectedDb ?? getConnection();
  }

  issue(token: Uint8Array, expiresAtMs: number, now: number): FleetPairingToken {
    if (!Number.isSafeInteger(expiresAtMs) || !Number.isSafeInteger(now) || now < 0 || expiresAtMs <= now) {
      throw new FleetPairingTokenInputError('expiresAtMs');
    }
    const hash = tokenHash(token);
    this.db.prepare(`INSERT INTO fleet_pairing_tokens (token_hash, created_at_ms, expires_at_ms)
      VALUES (?, ?, ?)`).run(hash, now, expiresAtMs);
    return { tokenHash: hash, createdAtMs: now, expiresAtMs, consumedAtMs: null };
  }

  consume(token: Uint8Array, now: number): FleetPairingTokenConsumeResult {
    const hash = tokenHash(token);
    const result = this.db.prepare(`UPDATE fleet_pairing_tokens SET consumed_at_ms = ?
      WHERE token_hash = ? AND consumed_at_ms IS NULL AND expires_at_ms > ?`).run(now, hash, now);
    if (result.changes === 1) return { kind: 'consumed' };
    const inspected = this.inspectHash(hash, now);
    switch (inspected.kind) {
      case 'not_found': return { kind: 'not_found' };
      case 'expired': return { kind: 'expired' };
      case 'already_consumed': return { kind: 'already_consumed' };
      case 'available': throw new FleetPairingTokenDataError('consume_result');
      default: {
        const exhaustive: never = inspected;
        return exhaustive;
      }
    }
  }

  inspect(token: Uint8Array, now: number): FleetPairingTokenInspectionResult {
    return this.inspectHash(tokenHash(token), now);
  }

  private inspectHash(hash: string, now: number): FleetPairingTokenInspectionResult {
    const persisted = this.findByHash(hash);
    if (persisted === undefined) return { kind: 'not_found' };
    if (persisted.consumedAtMs !== null) return { kind: 'already_consumed' };
    return persisted.expiresAtMs <= now ? { kind: 'expired' } : { kind: 'available' };
  }

  findByHash(hash: string): FleetPairingToken | undefined {
    const row = this.db.prepare<[string], TokenRow>(
      'SELECT token_hash, created_at_ms, expires_at_ms, consumed_at_ms FROM fleet_pairing_tokens WHERE token_hash = ?',
    ).get(hash);
    return row === undefined ? undefined : mapToken(row);
  }
}

export const fleetPairingTokensDb = new FleetPairingTokensRepository();
