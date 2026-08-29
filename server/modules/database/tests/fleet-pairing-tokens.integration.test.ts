import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Worker } from 'node:worker_threads';

import Database from 'better-sqlite3';

import { runMigrations } from '@/modules/database/migrations.js';
import { FleetPairingTokenDataError, FleetPairingTokensRepository } from '@/modules/database/repositories/fleet-pairing-tokens.js';
import { INIT_SCHEMA_SQL } from '@/modules/database/schema.js';

const NOW = 1_800_000_000_000;
const TOKEN = Uint8Array.from({ length: 32 }, (_, index) => index);

type TokenRow = Readonly<{ token_hash: string; consumed_at_ms: number | null }>;
type WorkerResult = Readonly<{ kind: 'result'; outcome: string }>;

function parseWorkerResult(value: unknown): WorkerResult {
  if (typeof value !== 'object' || value === null || !('kind' in value) || !('outcome' in value)
    || value.kind !== 'result' || typeof value.outcome !== 'string') {
    throw new TypeError('invalid fleet token consumer result');
  }
  return { kind: value.kind, outcome: value.outcome };
}

function openFleetDatabase(filename = ':memory:'): Database.Database {
  const db = new Database(filename);
  db.pragma('foreign_keys = ON');
  db.exec(INIT_SCHEMA_SQL);
  runMigrations(db);
  return db;
}

test('stores only a SHA-256 token hash and rejects expired consumption', () => {
  // Given: a newly issued 32-byte pairing token.
  const db = openFleetDatabase();
  const tokens = new FleetPairingTokensRepository(db);
  const issued = tokens.issue(TOKEN, NOW + 600_000, NOW);

  // When: storage is inspected and consumption occurs at the expiry boundary.
  const stored = db.prepare<[], TokenRow>(
    'SELECT token_hash, consumed_at_ms FROM fleet_pairing_tokens',
  ).get();
  const outcome = tokens.consume(TOKEN, NOW + 600_000);

  // Then: plaintext is absent, the digest is durable, and the stale token is not consumed.
  assert.deepEqual(stored, { token_hash: issued.tokenHash, consumed_at_ms: null });
  assert.equal(issued.tokenHash.length, 64);
  assert.equal(Buffer.from(TOKEN).toString('hex') === issued.tokenHash, false);
  assert.deepEqual(outcome, { kind: 'expired' });
  db.close();
});

test('classifies missing, consumed, and replayed tokens with single-use semantics', () => {
  // Given: one valid token and one token that was never issued.
  const db = openFleetDatabase();
  const tokens = new FleetPairingTokensRepository(db);
  tokens.issue(TOKEN, NOW + 600_000, NOW);
  const missingToken = Uint8Array.from({ length: 32 }, () => 255);

  // When: the missing token and valid token are consumed, then the valid token is replayed.
  const available = tokens.inspect(TOKEN, NOW + 1);
  const missing = tokens.consume(missingToken, NOW + 1);
  const consumed = tokens.consume(TOKEN, NOW + 1);
  const replayed = tokens.consume(TOKEN, NOW + 2);

  // Then: outcomes remain distinct and only the first valid consumption succeeds.
  assert.deepEqual([available.kind, missing.kind, consumed.kind, replayed.kind], [
    'available', 'not_found', 'consumed', 'already_consumed',
  ]);
  db.close();
});

test('atomically permits one of two concurrent token consumers', async () => {
  // Given: two worker consumers blocked on the same persisted token.
  const directory = mkdtempSync(join(tmpdir(), 'chatmux-fleet-token-race-'));
  const filename = join(directory, 'fleet.sqlite');
  const db = openFleetDatabase(filename);
  new FleetPairingTokensRepository(db).issue(TOKEN, NOW + 600_000, NOW);
  db.pragma('journal_mode = WAL');
  db.close();
  const gate = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const workerUrl = new URL('./fixtures/fleet-token-consumer.worker.ts', import.meta.url);
  const workers = [1, 2].map(() => new Worker(workerUrl, {
    workerData: { filename, token: [...TOKEN], now: NOW + 1, gate },
  }));

  try {
    await Promise.all(workers.map((worker) => once(worker, 'message', { signal: AbortSignal.timeout(10_000) })));
    const results = workers.map((worker) => once(worker, 'message', { signal: AbortSignal.timeout(10_000) }));

    // When: both consumers are released from the exact same barrier.
    Atomics.store(new Int32Array(gate), 0, 1);
    Atomics.notify(new Int32Array(gate), 0, workers.length);
    const messages = await Promise.all(results);

    // Then: exactly one atomic update consumes the token.
    const outcomes = messages.map(([message]) => parseWorkerResult(message).outcome).sort();
    assert.deepEqual(outcomes, ['already_consumed', 'consumed']);
  } finally {
    await Promise.all(workers.map((worker) => worker.terminate()));
    rmSync(directory, { recursive: true, force: true });
  }
});

test('rejects malformed persisted pairing tokens at the repository boundary', () => {
  // Given: a malformed hash inserted while constraints are bypassed.
  const db = openFleetDatabase();
  db.pragma('ignore_check_constraints = ON');
  db.prepare(`INSERT INTO fleet_pairing_tokens (
    token_hash, created_at_ms, expires_at_ms
  ) VALUES (?, ?, ?)`).run('not-a-sha256-hash', NOW, NOW + 1);
  db.pragma('ignore_check_constraints = OFF');

  // When/Then: reading cannot turn the malformed row into a trusted token.
  assert.throws(
    () => new FleetPairingTokensRepository(db).findByHash('not-a-sha256-hash'),
    FleetPairingTokenDataError,
  );
  db.close();
});
