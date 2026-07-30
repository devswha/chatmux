import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

import { runMigrations } from '@/modules/database/migrations.js';
import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { notificationPreferencesDb } from '@/modules/database/repositories/notification-preferences.js';
import { pushSubscriptionsDb } from '@/modules/database/repositories/push-subscriptions.js';
import { CompletionNotificationOutboxRepository } from '@/modules/database/repositories/completion-notification-outbox.js';
import { CompletionNotificationTargetsRepository } from '@/modules/database/repositories/completion-notification-targets.js';
import { INIT_SCHEMA_SQL } from '@/modules/database/schema.js';
import {
  completionAppIdentityKey,
  completionExternalGenerationIdentityFromSession,
  completionExternalGenerationIdentityKey,
  completionExternalGenerationPaneEvidenceKey,
} from '@/modules/database/services/completion-target-identity.service.js';

type Row = Record<string, unknown>;

const get = <T extends Row>(db: Database.Database, sql: string, ...parameters: unknown[]): T | undefined =>
  db.prepare(sql).get(...parameters) as T | undefined;

const all = <T extends Row>(db: Database.Database, sql: string, ...parameters: unknown[]): T[] =>
  db.prepare(sql).all(...parameters) as T[];

const withDatabase = (run: (db: Database.Database) => void): void => {
  const db = new Database(':memory:');
  try {
    db.exec(INIT_SCHEMA_SQL);
    runMigrations(db);
    run(db);
  } finally {
    db.close();
  }
};
const withRepositoryDatabase = (run: (db: Database.Database) => void): void => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chatmux-completion-'));
  const previousPath = process.env.DATABASE_PATH;
  process.env.DATABASE_PATH = path.join(directory, 'database.sqlite');
  try {
    const db = getConnection();
    db.exec(INIT_SCHEMA_SQL);
    runMigrations(db);
    run(db);
  } finally {
    closeConnection();
    if (previousPath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousPath;
    fs.rmSync(directory, { recursive: true, force: true });
  }
};

const addUser = (db: Database.Database, id: number, name = `user-${id}`): void => {
  db.prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)').run(id, name, 'hash');
};

const addSubscription = (db: Database.Database, userId: number, endpoint = `https://push/${userId}`): void => {
  db.prepare(`INSERT INTO push_subscriptions (user_id, endpoint, keys_p256dh, keys_auth)
    VALUES (?, ?, 'key', 'auth')`).run(userId, endpoint);
};

const enablePush = (db: Database.Database, userId: number): void => {
  db.prepare(`UPDATE completion_notification_policy
    SET desired_web_push = 1, enforcement_enabled = 1 WHERE user_id = ?`).run(userId);
};
const enableCompletionPreferences = (db: Database.Database, userId: number, liveStop = true): void => {
  db.prepare('INSERT INTO user_notification_preferences (user_id, preferences_json) VALUES (?, ?)')
    .run(userId, JSON.stringify({ channels: { webPush: true }, events: { liveStop, stop: true } }));
};

const payload = Object.freeze({
  title: 'Complete',
  body: 'Ready',
  navigation: Object.freeze({ href: '/sessions/demo', title: 'Complete' }),
});

const appDecision = (userId: number, targetIdentityKey: string, sessionId = 'session-1') => ({
  userId,
  preferenceClass: 'stop' as const,
  targetIdentityKey,
  provider: 'claude',
  sessionId,
  eventOccurrenceKey: 'turn-1',
  eventCode: 'reply_ready' as const,
  targetAliasSnapshot: 'alias',
  payload,
  now: 1_000,
});

test('v13 clamps legacy liveStop and direct valid JSON writes while completion policy remains all-off', () => {
  withDatabase((db) => {
    assert.deepEqual(all<{ version: number }>(db, 'SELECT version FROM schema_migrations ORDER BY version').map((row) => row.version),
      Array.from({ length: 15 }, (_, index) => index + 1));
    addUser(db, 1);
    assert.deepEqual(get<Row>(db, 'SELECT desired_web_push, consent_configured, enforcement_enabled FROM completion_notification_policy WHERE user_id = 1'),
      { desired_web_push: 0, consent_configured: 0, enforcement_enabled: 1 });
    db.prepare(`INSERT INTO user_notification_preferences (user_id, preferences_json) VALUES (?, ?)`)
      .run(1, JSON.stringify({ events: { liveStop: true } }));
    assert.equal(get<{ value: number }>(db, `SELECT json_extract(preferences_json, '$.events.liveStop') AS value FROM user_notification_preferences WHERE user_id = 1`)?.value, 0);
    db.prepare(`UPDATE user_notification_preferences
      SET preferences_json = ?
      WHERE user_id = 1`).run(JSON.stringify({ events: { liveStop: true } }));
    assert.equal(get<{ value: number }>(db, `SELECT json_extract(preferences_json, '$.events.liveStop') AS value FROM user_notification_preferences WHERE user_id = 1`)?.value, 0);
    runMigrations(db);
    assert.deepEqual(
      all<{ name: string }>(db, "SELECT name FROM pragma_table_info('completion_notification_generation_state')")
        .map((column) => column.name),
      [
        'generation_target_id',
        'high_water_seq',
        'armed_seq',
        'monitor_state',
        'last_evidence_cursor',
        'pane_evidence_key',
        'last_seen_at',
        'state_revision',
        'updated_at',
      ],
    );
    assert.equal(get<{ count: number }>(db, 'SELECT count(*) AS count FROM completion_notification_policy')?.count, 1);
  });

  const legacy = new Database(':memory:');
  try {
    legacy.exec(`PRAGMA foreign_keys = ON;
      CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL);
      CREATE TABLE user_notification_preferences (user_id INTEGER PRIMARY KEY, preferences_json TEXT NOT NULL,
        updated_at DATETIME, FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE);
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP);`);
    for (let version = 1; version <= 12; version += 1) legacy.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(version);
    legacy.prepare("INSERT INTO users VALUES (1, 'legacy', 'hash')").run();
    legacy.prepare("INSERT INTO users VALUES (2, 'empty', 'hash')").run();
    legacy.prepare('INSERT INTO user_notification_preferences VALUES (1, ?, CURRENT_TIMESTAMP)')
      .run(JSON.stringify({ events: { liveStop: true } }));
    legacy.prepare('INSERT INTO user_notification_preferences VALUES (2, ?, CURRENT_TIMESTAMP)')
      .run(JSON.stringify({ events: {} }));
    runMigrations(legacy);
    assert.deepEqual(get<Row>(legacy, 'SELECT desired_web_push, consent_configured, enforcement_enabled FROM completion_notification_policy WHERE user_id = 1'),
      { desired_web_push: 0, consent_configured: 0, enforcement_enabled: 1 });
    assert.deepEqual(get<Row>(legacy, 'SELECT desired_web_push, consent_configured, enforcement_enabled FROM completion_notification_policy WHERE user_id = 2'),
      { desired_web_push: 0, consent_configured: 0, enforcement_enabled: 1 });
    assert.equal(get<{ value: number }>(legacy, `SELECT json_extract(preferences_json, '$.events.liveStop') AS value FROM user_notification_preferences WHERE user_id = 1`)?.value, 0);
    assert.equal(get<{ value: number }>(legacy, `SELECT json_extract(preferences_json, '$.events.liveStop') AS value FROM user_notification_preferences WHERE user_id = 2`)?.value, 0);
    legacy.prepare('UPDATE user_notification_preferences SET preferences_json = ? WHERE user_id = 1')
      .run(JSON.stringify({
        channels: { webPush: true },
        events: { actionRequired: false, error: false, liveStop: true, stop: true },
      }));
    assert.deepEqual(get<Row>(legacy, `SELECT
      json_extract(preferences_json, '$.channels.webPush') AS web_push,
      json_extract(preferences_json, '$.events.actionRequired') AS action_required,
      json_extract(preferences_json, '$.events.error') AS error,
      json_extract(preferences_json, '$.events.stop') AS stop,
      json_extract(preferences_json, '$.events.liveStop') AS live_stop
      FROM user_notification_preferences WHERE user_id = 1`), {
      web_push: 1, action_required: 0, error: 0, stop: 1, live_stop: 0,
    });
    runMigrations(legacy);
    assert.deepEqual(
      all<{ name: string }>(legacy, "SELECT name FROM pragma_table_info('completion_notification_generation_state')")
        .map((column) => column.name).slice(-4),
      ['pane_evidence_key', 'last_seen_at', 'state_revision', 'updated_at'],
    );
    assert.equal(get<{ count: number }>(legacy, 'SELECT count(*) AS count FROM completion_notification_policy')?.count, 2);
  } finally {
    legacy.close();
  }
});

test('completion schema enforces exact foreign-key deletion behavior', () => {
  withDatabase((db) => {
    addUser(db, 1);
    addSubscription(db, 1);
    const targets = new CompletionNotificationTargetsRepository(db);
    const app = targets.createTarget('app', 'app', ['app-alias']);
    const disposable = targets.createTarget('disposable', 'app', ['disposable-alias']);
    db.prepare('INSERT INTO completion_notification_watch_mutations (user_id, mutation_id, alias, expected_revision, watched, target_id, result_kind, result_revision, result_global_paused) VALUES (1, ?, ?, 1, 1, ?, ?, 1, 0)')
      .run('mutation', 'disposable-alias', disposable.id, 'app');
    db.prepare(`INSERT INTO completion_notification_outbox (decision_id, decision_key, user_id, event_code, canonical_target_id, target_alias_snapshot, payload_json, notification_tag)
      VALUES ('decision', 'key', 1, 'reply_ready', ?, 'alias', '{}', 'tag')`).run(app.id);
    const outboxId = get<{ id: number }>(db, "SELECT id FROM completion_notification_outbox WHERE decision_id = 'decision'")!.id;
    db.prepare(`INSERT INTO completion_notification_deliveries (outbox_id, subscription_id, subscription_id_at_creation, endpoint_owner_id, endpoint_snapshot, next_due_at)
      VALUES (?, 1, 1, 1, 'https://push/1', 0)`).run(outboxId);
    db.prepare('DELETE FROM push_subscriptions WHERE id = 1').run();
    assert.equal(get<{ subscription_id: number | null }>(db, 'SELECT subscription_id FROM completion_notification_deliveries')?.subscription_id, null);
    db.prepare('DELETE FROM completion_notification_targets WHERE id = ?').run(app.id);
    assert.equal(get<{ canonical_target_id: number | null }>(db, 'SELECT canonical_target_id FROM completion_notification_outbox')?.canonical_target_id, null);
    db.prepare('DELETE FROM completion_notification_targets WHERE id = ?').run(disposable.id);
    assert.equal(get<{ target_id: number | null }>(db, 'SELECT target_id FROM completion_notification_watch_mutations')?.target_id, null);
    db.prepare('DELETE FROM users WHERE id = 1').run();
    assert.equal(get<Row>(db, 'SELECT * FROM completion_notification_outbox'), undefined);
  });
});

test('target aliases, redirects, merges, and transaction failures preserve canonical invariants', () => {
  withDatabase((db) => {
    const targets = new CompletionNotificationTargetsRepository(db);
    const first = targets.createTarget('first', 'app', ['shared']);
    assert.throws(() => targets.createTarget('second', 'app', ['shared']), /already owned/);
    assert.equal(get<Row>(db, "SELECT * FROM completion_notification_targets WHERE identity_key = 'second'"), undefined);
    assert.throws(() => db.prepare("UPDATE completion_notification_targets SET kind = 'external_generation' WHERE id = ?").run(first.id), /immutable/);
    assert.throws(() => db.prepare('UPDATE completion_notification_targets SET canonical_target_id = ? WHERE id = ?').run(first.id, first.id), /cycle/);

    const loser = targets.createTarget('loser', 'app', ['loser-alias']);
    const generation = targets.createTarget('generation', 'external_generation', ['generation-alias']);
    targets.promoteGenerationToApp('generation', 'first', ['promoted']);
    targets.mergeEquivalentApps([loser.id], first.id, () => true);
    assert.equal(targets.resolveAlias('loser-alias')?.id, first.id);
    assert.equal(targets.resolveTarget(loser.id)?.id, first.id);
    assert.equal(targets.resolveAlias('generation-alias')?.id, first.id);
    assert.equal(get<{ canonical_target_id: number }>(db, 'SELECT canonical_target_id FROM completion_notification_targets WHERE id = ?', generation.id)?.canonical_target_id, first.id);
    assert.throws(() => targets.mergeEquivalentApps([first.id], loser.id, () => true), /canonical app targets/);
  });
});
test('a live generation follows provider session changes without moving conversation watches', () => {
  withDatabase((db) => {
    addUser(db, 1);
    const targets = new CompletionNotificationTargetsRepository(db);
    const generation = targets.createTarget('generation', 'external_generation', ['generation-alias']);
    const first = targets.createTarget('first-app', 'app', ['first-app-alias']);
    const second = targets.createTarget('second-app', 'app', ['second-app-alias']);

    targets.promoteGenerationToApp(
      'generation',
      'first-app',
      ['first-app-alias'],
      ['generation-alias'],
    );
    db.prepare('INSERT INTO completion_notification_watches (user_id, target_id) VALUES (1, ?)')
      .run(first.id);
    targets.observeGeneration(generation.id, 'first-running', 'running');

    const rebound = targets.promoteGenerationToApp(
      'generation',
      'second-app',
      ['second-app-alias'],
      ['generation-alias'],
    );

    assert.equal(rebound.id, second.id);
    assert.equal(targets.resolveAlias('generation-alias')?.id, second.id);
    assert.equal(targets.resolveAlias('first-app-alias')?.id, first.id);
    assert.equal(targets.getWatch(1, first.id), true);
    assert.equal(targets.getWatch(1, second.id), false);
    assert.equal(
      get<{ count: number }>(db, 'SELECT count(*) AS count FROM completion_notification_generation_state WHERE generation_target_id = ?', generation.id)?.count,
      0,
      'the resumed conversation starts from a fresh activity baseline',
    );
    assert.ok(rebound.revision > first.revision, 'stale alias revisions cannot mutate the rebound target');
  });
});
test('stale watch mutations expose canonical state through survivor and loser aliases after app merge', () => {
  withDatabase((db) => {
    addUser(db, 1);
    const targets = new CompletionNotificationTargetsRepository(db);
    const survivor = targets.createTarget('survivor', 'app', ['survivor-alias']);
    const loser = targets.createTarget('loser', 'app', ['loser-alias']);

    assert.equal(targets.setWatch(1, {
      mutationId: 'watch-loser-before-merge', alias: 'loser-alias', expectedRevision: loser.revision, watched: true,
    }).ok, true);
    const merged = targets.mergeEquivalentApps([loser.id], survivor.id, () => true);
    assert.equal(merged.revision, 2);

    for (const alias of ['survivor-alias', 'loser-alias']) {
      assert.deepEqual(targets.setWatch(1, {
        mutationId: `stale-${alias}`, alias, expectedRevision: 0, watched: false,
      }), {
        ok: false,
        reason: 'revision_conflict',
        target: { alias, kind: 'app', revision: merged.revision, watched: true },
      });
    }

    const survivorRetry = targets.setWatch(1, {
      mutationId: 'retry-survivor', alias: 'survivor-alias', expectedRevision: merged.revision, watched: false,
    });
    assert.deepEqual(survivorRetry, {
      ok: true,
      target: { alias: 'survivor-alias', kind: 'app', revision: 3, watched: false },
      globalPaused: true,
    });
    const loserRetry = targets.setWatch(1, {
      mutationId: 'retry-loser', alias: 'loser-alias', expectedRevision: survivorRetry.target.revision, watched: true,
    });
    assert.deepEqual(loserRetry, {
      ok: true,
      target: { alias: 'loser-alias', kind: 'app', revision: 4, watched: true },
      globalPaused: true,
    });
    assert.equal(targets.resolveAlias('survivor-alias')?.id, targets.resolveAlias('loser-alias')?.id);
    assert.equal(targets.getWatch(1, survivor.id), true);
  });
});

test('generation observations establish baselines, arm turns, replay evidence, and survive restart', () => {
  withDatabase((db) => {
    const targets = new CompletionNotificationTargetsRepository(db);
    const generation = targets.createTarget('generation', 'external_generation');
    assert.deepEqual(targets.observeGeneration(generation.id, 'none', 'unavailable'), { state: 'unobserved', sequence: null, replay: true, stateRevision: 0 });
    assert.deepEqual(targets.observeGeneration(generation.id, 'baseline-terminal', 'failed'), { state: 'terminal', sequence: null, replay: false, stateRevision: 1 });
    const armed = targets.observeGeneration(generation.id, 'turn-1-running', 'running');
    assert.deepEqual(armed, { state: 'running', sequence: 1, replay: false, stateRevision: 2 });
    assert.deepEqual(targets.observeGeneration(generation.id, 'unavailable-running', 'unavailable'), { ...armed, replay: true });
    assert.deepEqual(targets.observeGeneration(generation.id, 'turn-1-running', 'asking'), { ...armed, replay: true });
    assert.deepEqual(targets.observeGeneration(generation.id, 'turn-1-done', 'failed'), { state: 'terminal', sequence: null, replay: false, stateRevision: 3 });
    const afterRestart = new CompletionNotificationTargetsRepository(db).observeGeneration(generation.id, 'turn-2-running', 'running');
    assert.deepEqual(afterRestart, { state: 'running', sequence: 2, replay: false, stateRevision: 4 });
    assert.deepEqual(targets.observeGeneration(generation.id, 'turn-2-done', 'unknown'), { state: 'terminal', sequence: null, replay: false, stateRevision: 5 });
    assert.deepEqual(targets.observeGeneration(generation.id, 'unavailable-terminal', 'unavailable'), { state: 'terminal', sequence: null, replay: true, stateRevision: 5 });
    assert.equal(targets.pruneStaleGenerationCandidates(1_000, []), 0);
    assert.equal(targets.generationCount(), 1);
  });
});
test('generation prune evidence is exact, strict, fail-closed, and preserves immutable outbox rows', () => {
  withDatabase((db) => {
    const targets = new CompletionNotificationTargetsRepository(db);
    const cutoff = 30 * 24 * 60 * 60 * 1_000;
    const paneEvidenceKey = completionExternalGenerationPaneEvidenceKey({
      socketPath: '/tmp/socket\u0000exact',
      sessionId: 'session',
      windowId: 'window',
      paneId: 'pane',
    });
    assert.equal(paneEvidenceKey, completionExternalGenerationPaneEvidenceKey({
      socketPath: '/tmp/socket\u0000exact',
      sessionId: 'session',
      windowId: 'window',
      paneId: 'pane',
    }));
    assert.notEqual(paneEvidenceKey, completionExternalGenerationPaneEvidenceKey({
      socketPath: '/tmp/socket\u0000exact-session',
      sessionId: 'session',
      windowId: 'window',
      paneId: 'pane',
    }));

    const equality = targets.createTarget('generation-equality', 'external_generation');
    const eligible = targets.createTarget('generation-eligible', 'external_generation');
    const incomplete = targets.createTarget('generation-incomplete', 'external_generation');
    targets.touchObservedGenerations([{ generationTargetId: equality.id, paneEvidenceKey }], cutoff);
    targets.touchObservedGenerations([{ generationTargetId: eligible.id, paneEvidenceKey }], cutoff - 1);
    targets.observeGeneration(incomplete.id, 'terminal', 'failed');

    assert.deepEqual(targets.listStaleGenerationCandidates(cutoff), [{
      generationTargetId: eligible.id,
      paneEvidenceKey,
      lastSeenAt: cutoff - 1,
    }]);
    assert.equal(targets.pruneStaleGenerationCandidates(cutoff, []), 0, 'repository never bulk-prunes stale rows');
    assert.equal(targets.generationCount(), 3);

    targets.touchObservedGenerations([{ generationTargetId: eligible.id, paneEvidenceKey }], cutoff + 1);
    assert.equal(targets.pruneStaleGenerationCandidates(cutoff, [eligible.id]), 0);
    assert.equal(targets.pruneStaleGenerationCandidates(cutoff, [equality.id]), 0, 'cutoff equality is retained');
    assert.equal(targets.generationCount(), 3);

    addUser(db, 1);
    db.prepare('INSERT INTO completion_notification_watches (user_id, target_id) VALUES (1, ?)')
      .run(eligible.id);
    db.prepare(`INSERT INTO completion_notification_outbox
      (decision_id, decision_key, user_id, event_code, canonical_target_id, target_alias_snapshot, payload_json, notification_tag)
      VALUES ('prune-decision', 'prune-key', 1, 'reply_ready', ?, 'eligible', '{}', 'tag')`).run(eligible.id);
    targets.touchObservedGenerations([{ generationTargetId: eligible.id, paneEvidenceKey }], cutoff - 1);
    assert.equal(get<{ count: number }>(db, 'SELECT count(*) AS count FROM completion_notification_watches WHERE target_id = ?', eligible.id)?.count, 1);
    assert.equal(targets.pruneStaleGenerationCandidates(cutoff, [eligible.id]), 1);

    assert.equal(targets.generationCount(), 2);
    assert.equal(get<Row>(db, 'SELECT * FROM completion_notification_generation_state WHERE generation_target_id = ?', eligible.id), undefined);
    assert.equal(get<{ count: number }>(db, 'SELECT count(*) AS count FROM completion_notification_watches WHERE target_id = ?', eligible.id)?.count, 0);
    assert.deepEqual(get<Row>(db, "SELECT decision_id, canonical_target_id FROM completion_notification_outbox WHERE decision_id = 'prune-decision'"),
      { decision_id: 'prune-decision', canonical_target_id: null });
    assert.equal(targets.listStaleGenerationCandidates(cutoff).length, 0);
    assert.notEqual(get<Row>(db, 'SELECT * FROM completion_notification_generation_state WHERE generation_target_id = ?', incomplete.id), undefined);
  });
});

test('watch mutations are idempotent with CAS conflicts and global pause state', () => {
  withDatabase((db) => {
    addUser(db, 1);
    const targets = new CompletionNotificationTargetsRepository(db);
    const app = targets.createTarget('app', 'app', ['alias']);
    const mutation = { mutationId: 'same', alias: 'alias', expectedRevision: 1, watched: true };
    const first = targets.setWatch(1, mutation);
    assert.deepEqual(targets.setWatch(1, mutation), first);
    assert.deepEqual(targets.setWatch(1, { ...mutation, watched: false }), { ok: false, reason: 'mutation_replay_conflict' });
    assert.deepEqual(targets.setWatch(1, { mutationId: 'stale', alias: 'alias', expectedRevision: 1, watched: false }), {
      ok: false,
      reason: 'revision_conflict',
      target: { alias: 'alias', kind: 'app', revision: 2, watched: true },
    });
    assert.equal(first.ok && first.globalPaused, true);
    const sameState = targets.setWatch(1, { mutationId: 'same-state', alias: 'alias', expectedRevision: 2, watched: true });
    assert.equal(sameState.ok && sameState.target.revision, 2);
    assert.deepEqual(targets.setWatch(1, { mutationId: 'same-state', alias: 'alias', expectedRevision: 2, watched: true }), sameState);
    enablePush(db, 1);
    const next = targets.setWatch(1, { mutationId: 'off', alias: 'alias', expectedRevision: 2, watched: false });
    assert.equal(next.ok && next.globalPaused, false);
    assert.equal(targets.getWatch(1, app.id), false);
  });
});

test('terminal decisions fan out owners once and enforce delivery claims, pause, backoff, endpoint closure, and CAS', () => {
  withDatabase((db) => {
    addUser(db, 1); addUser(db, 2);
    addSubscription(db, 1, 'https://push/shared'); addSubscription(db, 2, 'https://push/two');
    enableCompletionPreferences(db, 1); enableCompletionPreferences(db, 2);
    enablePush(db, 1); enablePush(db, 2);
    const targets = new CompletionNotificationTargetsRepository(db);
    const app = targets.createTarget('app', 'app', ['app']);
    const generation = targets.createTarget('generation', 'external_generation', ['generation']);
    targets.promoteGenerationToApp('generation', 'app');
    db.prepare('INSERT INTO completion_notification_watches (user_id, target_id) VALUES (1, ?), (2, ?)').run(app.id, app.id);
    targets.observeGeneration(generation.id, 'running', 'running');
    const outbox = new CompletionNotificationOutboxRepository(db);
    const decisions = outbox.createTerminalDecision({ generationTargetId: generation.id, evidenceCursor: 'done', eventCode: 'reply_ready', targetAliasSnapshot: 'generation', payload, now: 100 });
    assert.equal(decisions.length, 2);
    assert.deepEqual(outbox.createTerminalDecision({ generationTargetId: generation.id, evidenceCursor: 'done', eventCode: 'reply_ready', targetAliasSnapshot: 'generation', payload, now: 100 }), decisions);
    const claims = outbox.claimDue(100, 10, 10);
    assert.equal(claims.length, 2);
    assert.equal(outbox.prepareSend(claims[0]!.id, 'stale-token'), false);
    assert.equal(outbox.prepareSend(claims[0]!.id, claims[0]!.claimToken), true);
    assert.equal(outbox.retry(claims[0]!.id, claims[0]!.claimToken, 200, 'network'), true);
    const beforeRetry = outbox.claimDue(199);
    assert.equal(beforeRetry.length, 1);
    assert.equal(beforeRetry[0]!.id, claims.find((claim) => claim.id !== claims[0]!.id)!.id);
    assert.deepEqual(get<{ state: string; next_due_at: number }>(db,
      'SELECT state, next_due_at FROM completion_notification_deliveries WHERE id = ?', claims[0]!.id),
    { state: 'transient_retry', next_due_at: 200 });
    const retry = outbox.claimDue(200)[0]!;
    assert.equal(retry.attemptCount, 1);
    db.prepare(`UPDATE completion_notification_policy SET desired_web_push = 0 WHERE user_id = 2`).run();
    db.prepare(`UPDATE completion_notification_deliveries SET state = 'paused_global', claim_token = NULL,
      claim_expires_at = NULL WHERE endpoint_owner_id = 2 AND state IN ('pending', 'claimed', 'transient_retry')`).run();
    const paused = claims.find((claim) => claim.id !== retry.id)!;
    assert.equal(outbox.prepareSend(paused.id, paused.claimToken), false);
    assert.equal(outbox.getDeliveryState(paused.id), 'paused_global');
    assert.equal(outbox.endpointGone(retry.id, retry.claimToken), true);
    assert.equal(get<Row>(db, "SELECT * FROM push_subscriptions WHERE endpoint = 'https://push/shared'"), undefined);
    assert.equal(outbox.getDeliveryState(retry.id), 'endpoint_removed');
  });
});
test('duplicate panes observing the same conversation and terminal evidence create one notification', () => {
  withDatabase((db) => {
    addUser(db, 1); addSubscription(db, 1); enableCompletionPreferences(db, 1); enablePush(db, 1);
    const targets = new CompletionNotificationTargetsRepository(db);
    const app = targets.createTarget('shared-app', 'app');
    const first = targets.createTarget('first-generation', 'external_generation');
    const second = targets.createTarget('second-generation', 'external_generation');
    targets.promoteGenerationToApp('first-generation', 'shared-app');
    targets.promoteGenerationToApp('second-generation', 'shared-app');
    db.prepare('INSERT INTO completion_notification_watches (user_id, target_id) VALUES (1, ?)')
      .run(app.id);
    targets.observeGeneration(first.id, 'first-running', 'running');
    targets.observeGeneration(second.id, 'second-running', 'running');

    const outbox = new CompletionNotificationOutboxRepository(db);
    const input = {
      evidenceCursor: 'same-provider-turn',
      eventCode: 'reply_ready' as const,
      targetAliasSnapshot: 'shared-app',
      payload,
      now: 100,
    };
    const decided = outbox.recordTerminalDecision({ ...input, generationTargetId: first.id });
    const replay = outbox.recordTerminalDecision({ ...input, generationTargetId: second.id });

    assert.equal(decided.status, 'decided');
    assert.equal(decided.decisionIds.length, 1);
    assert.deepEqual(replay, { status: 'replay', decisionIds: decided.decisionIds });
    assert.equal(get<{ count: number }>(db, 'SELECT count(*) AS count FROM completion_notification_outbox')?.count, 1);
  });
});

test('terminal recording durably baselines unarmed evidence and consumes a persisted running arm after restart', () => {
  withDatabase((db) => {
    addUser(db, 1); addSubscription(db, 1); enableCompletionPreferences(db, 1); enablePush(db, 1);
    const targets = new CompletionNotificationTargetsRepository(db);
    const app = targets.createTarget('app', 'app');
    const generation = targets.createTarget('generation', 'external_generation');
    targets.promoteGenerationToApp('generation', 'app');
    db.prepare('INSERT INTO completion_notification_watches (user_id, target_id) VALUES (1, ?)').run(app.id);
    const input = { generationTargetId: generation.id, evidenceCursor: 'done-0', eventCode: 'reply_ready' as const, targetAliasSnapshot: 'generation', payload, now: 100 };
    const outbox = new CompletionNotificationOutboxRepository(db);
    assert.deepEqual(outbox.recordTerminalDecision(input), { status: 'baselined', decisionIds: [] });
    assert.deepEqual(outbox.recordTerminalDecision(input), { status: 'replay', decisionIds: [] });
    targets.observeGeneration(generation.id, 'running-1', 'running');
    const afterRestart = new CompletionNotificationOutboxRepository(db).recordTerminalDecision({
      ...input, evidenceCursor: 'done-1',
    });
    assert.equal(afterRestart.status, 'decided');
    assert.equal(afterRestart.decisionIds.length, 1);
    assert.deepEqual(new CompletionNotificationOutboxRepository(db).recordTerminalDecision({
      ...input, evidenceCursor: 'done-1',
    }), { status: 'replay', decisionIds: afterRestart.decisionIds });
  });
});
test('terminal canonical-resolution failure throws and preserves the armed generation transaction state', () => {
  withDatabase((db) => {
    const targets = new CompletionNotificationTargetsRepository(db);
    const generation = targets.createTarget('generation', 'external_generation');
    targets.observeGeneration(generation.id, 'running', 'running');
    db.exec('PRAGMA foreign_keys = OFF');
    db.prepare('DELETE FROM completion_notification_targets WHERE id = ?').run(generation.id);

    assert.throws(() => new CompletionNotificationOutboxRepository(db).recordTerminalDecision({
      generationTargetId: generation.id, evidenceCursor: 'done', eventCode: 'reply_ready',
      targetAliasSnapshot: 'generation', payload, now: 100,
    }), /could not resolve canonical target/);
    assert.deepEqual(get<Row>(db, `SELECT monitor_state, armed_seq, last_evidence_cursor
      FROM completion_notification_generation_state WHERE generation_target_id = ?`, generation.id), {
      monitor_state: 'running', armed_seq: 1, last_evidence_cursor: 'running',
    });
  });
});
test('terminal fanout fails loudly and rolls back when persisted completion preferences are malformed', () => {
  withDatabase((db) => {
    addUser(db, 1); addUser(db, 2); addUser(db, 3);
    addSubscription(db, 1); addSubscription(db, 2); addSubscription(db, 3);
    enableCompletionPreferences(db, 1);
    enableCompletionPreferences(db, 2, false);
    db.prepare('UPDATE completion_notification_policy SET enforcement_enabled = 0 WHERE user_id = 3').run();
    db.prepare('INSERT INTO user_notification_preferences (user_id, preferences_json) VALUES (3, ?)')
      .run('{corrupt');
    enablePush(db, 1); enablePush(db, 2); enablePush(db, 3);
    const targets = new CompletionNotificationTargetsRepository(db);
    const app = targets.createTarget('app', 'app');
    const generation = targets.createTarget('generation', 'external_generation');
    targets.promoteGenerationToApp('generation', 'app');
    db.prepare('INSERT INTO completion_notification_watches (user_id, target_id) VALUES (1, ?), (2, ?), (3, ?)')
      .run(app.id, app.id, app.id);
    targets.observeGeneration(generation.id, 'running', 'running');
    assert.throws(() => new CompletionNotificationOutboxRepository(db).createTerminalDecision({
      generationTargetId: generation.id, evidenceCursor: 'done', eventCode: 'reply_ready',
      targetAliasSnapshot: 'generation', payload, now: 100,
    }), /malformed JSON/);
    assert.equal(get<{ count: number }>(db, 'SELECT count(*) AS count FROM completion_notification_outbox')?.count, 0);
    assert.deepEqual(get<Row>(db, `SELECT monitor_state, armed_seq, last_evidence_cursor
      FROM completion_notification_generation_state WHERE generation_target_id = ?`, generation.id), {
      monitor_state: 'running', armed_seq: 1, last_evidence_cursor: 'running',
    });
  });
});

test('application decisions require active watched targets and retain exact byte identity', () => {
  withDatabase((db) => {
    addUser(db, 1); addSubscription(db, 1); enablePush(db, 1);
    db.prepare(`INSERT INTO user_notification_preferences (user_id, preferences_json) VALUES (1, ?)`)
      .run(JSON.stringify({ channels: { webPush: true }, events: { stop: true } }));
    db.prepare("INSERT INTO projects (project_id, project_path) VALUES ('project', '/project')").run();
    db.prepare("INSERT INTO sessions (session_id, provider, project_path) VALUES ('session-1', 'claude', '/project')").run();
    const composed = 'é'; const decomposed = 'e\u0301';
    assert.notEqual(completionAppIdentityKey({ provider: 'claude', sessionId: composed }), completionAppIdentityKey({ provider: 'claude', sessionId: decomposed }));
    assert.throws(() => completionAppIdentityKey({ provider: 'claude', sessionId: '\ud800' }), /unpaired surrogate/);
    assert.equal(completionExternalGenerationIdentityFromSession({
      kind: 'cursor', tmux: {} as any,
    } as any), null);
    assert.throws(() => completionExternalGenerationIdentityFromSession({
      kind: 'claude', tmux: { socketPath: 'socket', sessionId: 's', windowId: 'w', paneId: 'p' },
      agentPid: undefined, startedAtMs: 1,
    } as any), /agentPid/);
    assert.throws(() => completionExternalGenerationIdentityKey({ provider: 'claude', socketPath: '\ud800', sessionId: 's', windowId: 'w', paneId: 'p', agentPid: 1, startedAtMs: 1 }), /unpaired surrogate/);
    assert.doesNotThrow(() => completionAppIdentityKey({ provider: 'claude', sessionId: 'session-\ud83d\ude80' }));
    const targets = new CompletionNotificationTargetsRepository(db);
    const identity = completionAppIdentityKey({ provider: 'claude', sessionId: 'session-1' });
    const app = targets.createTarget(identity, 'app', ['app']);
    const outbox = new CompletionNotificationOutboxRepository(db);
    assert.deepEqual(outbox.createApplicationDecision({
      ...appDecision(1, identity),
      eventOccurrenceKey: 'unwatched',
    }), []);
    assert.deepEqual(get<{ decisions: number; deliveries: number }>(db, `
      SELECT
        (SELECT COUNT(*) FROM completion_notification_outbox) AS decisions,
        (SELECT COUNT(*) FROM completion_notification_deliveries) AS deliveries
    `), { decisions: 0, deliveries: 0 });
    db.prepare('INSERT INTO completion_notification_watches (user_id, target_id) VALUES (1, ?)').run(app.id);
    const created = outbox.createApplicationDecision(appDecision(1, identity));
    assert.equal(created.length, 1);
    assert.deepEqual(outbox.createApplicationDecision(appDecision(1, identity)), created);
    assert.equal(outbox.createApplicationDecision({
      ...appDecision(1, identity),
      preferenceClass: 'liveStop',
      eventOccurrenceKey: 'live-stop',
    }).length, 1);
    db.prepare(`UPDATE user_notification_preferences
      SET preferences_json = ? WHERE user_id = 1`)
      .run(JSON.stringify({ channels: { webPush: true }, events: { stop: false, liveStop: true } }));
    assert.deepEqual(outbox.createApplicationDecision({
      ...appDecision(1, identity),
      eventOccurrenceKey: 'stop-disabled',
    }), []);
    db.prepare("UPDATE user_notification_preferences SET preferences_json = '{corrupt' WHERE user_id = 1").run();
    assert.throws(() => outbox.createApplicationDecision({
      ...appDecision(1, identity), eventOccurrenceKey: 'corrupt-preferences',
    }), /malformed JSON/);
    assert.throws(() => outbox.createApplicationDecision({
      ...appDecision(1, identity), provider: 'codex', eventOccurrenceKey: 'mismatch',
    }), /does not match/);
  });
});
test('promotion replays watched generations and merge retargets every loser only with authorization', () => {
  withDatabase((db) => {
    addUser(db, 1);
    const targets = new CompletionNotificationTargetsRepository(db);
    const survivor = targets.createTarget('survivor', 'app', ['survivor']);
    const loserOne = targets.createTarget('loser-one', 'app', ['loser-one']);
    const loserTwo = targets.createTarget('loser-two', 'app', ['loser-two']);
    const generation = targets.createTarget('generation', 'external_generation', ['generation']);
    db.prepare('INSERT INTO completion_notification_watches (user_id, target_id) VALUES (1, ?)').run(generation.id);

    targets.promoteGenerationToApp('generation', 'loser-one');
    assert.equal(targets.getWatch(1, loserOne.id), true);
    assert.equal(targets.resolveAlias('generation')?.id, loserOne.id);
    assert.equal(targets.promoteGenerationToApp('generation', 'loser-one').id, loserOne.id);
    assert.equal(targets.getWatch(1, loserOne.id), true);
    assert.throws(
      () => db.prepare('UPDATE completion_notification_targets SET canonical_target_id = ? WHERE id = ?')
        .run(survivor.id, loserOne.id),
      /authorization/,
    );

    assert.throws(() => targets.mergeEquivalentApps([loserOne.id, loserTwo.id], survivor.id, () => false), /proof failed/);
    assert.equal(targets.resolveAlias('loser-one')?.id, loserOne.id);
    assert.equal(get<{ count: number }>(db, 'SELECT COUNT(*) AS count FROM completion_notification_redirect_authorizations')?.count, 0);

    targets.mergeEquivalentApps([loserOne.id, loserTwo.id], survivor.id, () => true);
    assert.equal(targets.resolveAlias('loser-one')?.id, survivor.id);
    assert.equal(targets.resolveAlias('generation')?.id, survivor.id);
    assert.equal(targets.resolveTarget(loserOne.id)?.id, survivor.id);
    assert.equal(targets.resolveTarget(loserTwo.id)?.id, survivor.id);
    assert.equal(targets.resolveTarget(generation.id)?.id, survivor.id);
    assert.equal(targets.getWatch(1, survivor.id), true);
    assert.equal(get<{ count: number }>(db, 'SELECT COUNT(*) AS count FROM completion_notification_redirect_authorizations')?.count, 0);
  });
});

test('target resolution rejects corrupt redirects instead of traversing them', () => {
  withDatabase((db) => {
    const targets = new CompletionNotificationTargetsRepository(db);
    const first = targets.createTarget('first', 'app');
    const second = targets.createTarget('second', 'app');
    const generation = targets.createTarget('generation', 'external_generation');
    db.exec('DROP TRIGGER completion_notification_targets_validate_redirect');
    db.exec('PRAGMA foreign_keys = OFF');

    db.prepare('UPDATE completion_notification_targets SET canonical_target_id = ? WHERE id = ?')
      .run(second.id, first.id);
    assert.equal(targets.resolveTarget(first.id)?.id, second.id);

    db.prepare('UPDATE completion_notification_targets SET canonical_target_id = ? WHERE id = ?')
      .run(generation.id, second.id);
    assert.throws(() => targets.resolveTarget(first.id), /redirect invariant/);

    db.prepare('UPDATE completion_notification_targets SET canonical_target_id = ? WHERE id = ?')
      .run(first.id, second.id);
    assert.throws(() => targets.resolveTarget(first.id), /redirect invariant/);

    db.prepare('UPDATE completion_notification_targets SET canonical_target_id = NULL WHERE id = ?').run(second.id);
    db.prepare('UPDATE completion_notification_targets SET canonical_target_id = ? WHERE id = ?')
      .run(generation.id, first.id);
    assert.throws(() => targets.resolveTarget(first.id), /redirect invariant/);

    db.prepare('UPDATE completion_notification_targets SET canonical_target_id = 999 WHERE id = ?').run(first.id);
    assert.throws(() => targets.resolveTarget(first.id), /redirect invariant/);
  });
});
test('outbox entry points fail closed on corrupt redirects', () => {
  withDatabase((db) => {
    addUser(db, 1); addSubscription(db, 1); enablePush(db, 1);
    db.prepare(`INSERT INTO user_notification_preferences (user_id, preferences_json) VALUES (1, ?)`)
      .run(JSON.stringify({ channels: { webPush: true }, events: { stop: true } }));
    db.prepare("INSERT INTO projects (project_id, project_path) VALUES ('project', '/project')").run();
    db.prepare("INSERT INTO sessions (session_id, provider, project_path) VALUES ('session-1', 'claude', '/project')").run();
    const targets = new CompletionNotificationTargetsRepository(db);
    const identity = completionAppIdentityKey({ provider: 'claude', sessionId: 'session-1' });
    const app = targets.createTarget(identity, 'app');
    const generation = targets.createTarget('generation', 'external_generation');
    targets.promoteGenerationToApp('generation', identity);
    db.prepare('INSERT INTO completion_notification_watches (user_id, target_id) VALUES (1, ?)').run(app.id);
    targets.observeGeneration(generation.id, 'running', 'running');
    db.exec('DROP TRIGGER completion_notification_targets_validate_redirect');
    db.exec('PRAGMA foreign_keys = OFF');
    db.prepare('UPDATE completion_notification_targets SET canonical_target_id = ? WHERE id = ?')
      .run(generation.id, app.id);

    const outbox = new CompletionNotificationOutboxRepository(db);
    assert.throws(() => outbox.createTerminalDecision({
      generationTargetId: generation.id, evidenceCursor: 'done', eventCode: 'reply_ready',
      targetAliasSnapshot: 'generation', payload, now: 100,
    }), /redirect invariant/);
    assert.throws(() => outbox.createApplicationDecision(appDecision(1, identity)), /redirect invariant/);
  });
});

test('completion preference updates merge partial state, require consent to enable, and atomically pause on disable', () => {
  withRepositoryDatabase((db) => {
    addUser(db, 1);
    const outboxId = db.prepare(`INSERT INTO completion_notification_outbox
      (decision_id, decision_key, user_id, event_code, target_alias_snapshot, payload_json, notification_tag)
      VALUES ('decision', 'key', 1, 'reply_ready', 'alias', '{}', 'tag')`).run().lastInsertRowid;
    for (const [index, state] of ['pending', 'claimed', 'transient_retry', 'paused_global'].entries()) {
      db.prepare(`INSERT INTO completion_notification_deliveries
        (outbox_id, subscription_id_at_creation, endpoint_owner_id, endpoint_snapshot, state, next_due_at, claim_token)
        VALUES (?, ?, 1, 'https://push/1', ?, 1, 'claim')`).run(outboxId, index + 1, state);
    }

    const enabled = { channels: { webPush: true }, events: { stop: true } };
    assert.throws(() => notificationPreferencesDb.updateCompletionPreferencesAndDeliveryState(1, enabled, 10),
      /requires explicit click consent/);
    assert.deepEqual(get<Row>(db, 'SELECT desired_web_push, consent_configured FROM completion_notification_policy WHERE user_id = 1'),
      { desired_web_push: 0, consent_configured: 0 });
    assert.equal(notificationPreferencesDb.updateCompletionPreferencesAndDeliveryState(1, enabled, 20, true).wakeDispatcher, true);
    assert.deepEqual(get<Row>(db, 'SELECT desired_web_push, consent_configured FROM completion_notification_policy WHERE user_id = 1'),
      { desired_web_push: 1, consent_configured: 1 });
    const partial = notificationPreferencesDb.updateCompletionPreferencesAndDeliveryState(1, {
      events: { error: false, liveStop: true },
    }, 25);
    assert.deepEqual(partial.preferences, {
      channels: { inApp: false, webPush: true, sound: true },
      events: { actionRequired: true, stop: true, liveStop: false, error: false },
    });
    assert.deepEqual(get<Row>(db, 'SELECT desired_web_push, consent_configured FROM completion_notification_policy WHERE user_id = 1'),
      { desired_web_push: 1, consent_configured: 1 });
    // A settings save round-trips the full preference object, including an
    // already-consented webPush: true. That is not a fresh enable and must not
    // fail the whole write.
    const resave = notificationPreferencesDb.updateCompletionPreferencesAndDeliveryState(1, {
      channels: { inApp: false, webPush: true, sound: false }, events: { stop: true },
    }, 26);
    assert.equal(resave.preferences.channels.webPush, true);
    assert.equal(resave.preferences.channels.sound, false, 'the unrelated setting in the same save is persisted');
    assert.deepEqual(get<Row>(db, 'SELECT desired_web_push, consent_configured FROM completion_notification_policy WHERE user_id = 1'),
      { desired_web_push: 1, consent_configured: 1 });
    assert.throws(() => notificationPreferencesDb.updateCompletionPreferencesAndDeliveryState(1, {
      channels: { webPush: 'true' },
    }, 26), /must be a boolean/);
    db.prepare('UPDATE completion_notification_policy SET enforcement_enabled = 0 WHERE user_id = 1').run();
    assert.equal(notificationPreferencesDb.updateCompletionPreferencesAndDeliveryState(1, {
      events: { actionRequired: false },
    }, 27).wakeDispatcher, false);
    assert.deepEqual(get<Row>(db, `SELECT desired_web_push, enforcement_enabled
      FROM completion_notification_policy WHERE user_id = 1`), { desired_web_push: 1, enforcement_enabled: 0 });
    assert.equal(notificationPreferencesDb.updateCompletionPreferencesAndDeliveryState(1, {
      channels: { webPush: false },
    }, 30).wakeDispatcher, false);
    assert.deepEqual(get<Row>(db, `SELECT desired_web_push, consent_configured, enforcement_enabled
      FROM completion_notification_policy WHERE user_id = 1`), {
      desired_web_push: 0, consent_configured: 1, enforcement_enabled: 0,
    });
    assert.equal(get<{ count: number }>(db, "SELECT COUNT(*) AS count FROM completion_notification_deliveries WHERE state = 'paused_global'")?.count, 4);
    db.prepare("UPDATE user_notification_preferences SET preferences_json = '{corrupt' WHERE user_id = 1").run();
    assert.throws(() => notificationPreferencesDb.getNotificationPreferences(1), /invalid JSON/);
  });
});
test('explicit consent enables an enforced live-stop watch through its terminal decision', () => {
  withRepositoryDatabase((db) => {
    addUser(db, 1);
    addSubscription(db, 1);
    const update = notificationPreferencesDb.updateCompletionPreferencesAndDeliveryState(1, {
      channels: { webPush: true },
      events: { liveStop: true },
    }, 100, true);
    assert.equal(update.wakeDispatcher, true);
    assert.deepEqual(get<Row>(db, `SELECT desired_web_push, consent_configured, enforcement_enabled
      FROM completion_notification_policy WHERE user_id = 1`), {
      desired_web_push: 1, consent_configured: 1, enforcement_enabled: 1,
    });

    db.prepare("INSERT INTO projects (project_id, project_path) VALUES ('project', '/project')").run();
    db.prepare("INSERT INTO sessions (session_id, provider, project_path) VALUES ('session-1', 'claude', '/project')").run();
    const identity = completionAppIdentityKey({ provider: 'claude', sessionId: 'session-1' });
    const targets = new CompletionNotificationTargetsRepository(db);
    targets.createTarget(identity, 'app', ['app']);
    const generation = targets.createTarget('generation', 'external_generation', ['generation']);
    const promoted = targets.promoteGenerationToApp('generation', identity);
    assert.equal(targets.setWatch(1, {
      mutationId: 'watch-after-consent', alias: 'app', expectedRevision: promoted.revision, watched: true,
    }).ok, true);
    targets.observeGeneration(generation.id, 'running', 'running');

    const decisions = new CompletionNotificationOutboxRepository(db).createTerminalDecision({
      generationTargetId: generation.id, evidenceCursor: 'done', eventCode: 'reply_ready',
      targetAliasSnapshot: 'generation', payload, now: 200,
    });
    assert.equal(decisions.length, 1);
    assert.deepEqual(get<Row>(db, `SELECT state, endpoint_owner_id
      FROM completion_notification_deliveries`), { state: 'pending', endpoint_owner_id: 1 });
    assert.equal(new CompletionNotificationOutboxRepository(db).createApplicationDecision({
      userId: 1,
      preferenceClass: 'liveStop',
      targetIdentityKey: identity,
      provider: 'claude',
      sessionId: 'session-1',
      eventOccurrenceKey: 'click-consented-live-stop',
      eventCode: 'reply_ready',
      targetAliasSnapshot: 'app',
      payload,
      now: 201,
    }).length, 1);
  });
});
test('subscription deletion closes only the owning endpoint or user open deliveries', () => {
  withRepositoryDatabase((db) => {
    addUser(db, 1); addUser(db, 2);
    addSubscription(db, 1, 'https://push/one'); addSubscription(db, 1, 'https://push/two');
    addSubscription(db, 2, 'https://push/other');
    const outboxId = db.prepare(`INSERT INTO completion_notification_outbox
      (decision_id, decision_key, user_id, event_code, target_alias_snapshot, payload_json, notification_tag)
      VALUES ('decision', 'key', 1, 'reply_ready', 'alias', '{}', 'tag')`).run().lastInsertRowid;
    const delivery = db.prepare(`INSERT INTO completion_notification_deliveries
      (outbox_id, subscription_id_at_creation, endpoint_owner_id, endpoint_snapshot, state, next_due_at)
      VALUES (?, ?, ?, ?, ?, 1)`);
    let subscriptionIdAtCreation = 1;
    for (const state of ['pending', 'claimed', 'transient_retry', 'paused_global', 'acknowledged']) {
      delivery.run(outboxId, subscriptionIdAtCreation++, 1, 'https://push/one', state);
      delivery.run(outboxId, subscriptionIdAtCreation++, 2, 'https://push/other', state);
    }
    delivery.run(outboxId, subscriptionIdAtCreation, 1, 'https://push/two', 'pending');

    assert.equal(pushSubscriptionsDb.deletePushSubscriptionForUser(1, 'https://push/one'), true);
    assert.equal(get<{ count: number }>(db, `SELECT COUNT(*) AS count FROM completion_notification_deliveries
      WHERE endpoint_snapshot = 'https://push/one' AND state = 'endpoint_removed'`)?.count, 4);
    assert.equal(get<{ state: string }>(db, `SELECT state FROM completion_notification_deliveries
      WHERE endpoint_snapshot = 'https://push/one' AND state = 'acknowledged'`)?.state, 'acknowledged');
    assert.equal(get<{ count: number }>(db, "SELECT COUNT(*) AS count FROM push_subscriptions WHERE user_id = 1")?.count, 1);

    pushSubscriptionsDb.deletePushSubscriptionsForUser(2);
    assert.equal(get<{ count: number }>(db, `SELECT COUNT(*) AS count FROM completion_notification_deliveries
      WHERE endpoint_snapshot = 'https://push/other' AND state = 'endpoint_removed'`)?.count, 4);
    assert.equal(get<{ state: string }>(db, `SELECT state FROM completion_notification_deliveries
      WHERE endpoint_snapshot = 'https://push/other' AND state = 'acknowledged'`)?.state, 'acknowledged');
    assert.equal(get<{ count: number }>(db, 'SELECT COUNT(*) AS count FROM push_subscriptions WHERE user_id = 2')?.count, 0);
    assert.equal(get<{ state: string }>(db, "SELECT state FROM completion_notification_deliveries WHERE endpoint_snapshot = 'https://push/two'")?.state, 'pending');
  });
});
