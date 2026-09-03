import assert from 'node:assert/strict';
import test from 'node:test';

import Database from 'better-sqlite3';

import { runMigrations } from '@/modules/database/migrations.js';
import { CompletionNotificationTargetsRepository } from '@/modules/database/repositories/completion-notification-targets.js';
import {
  addSubscription,
  addUser,
  all,
  get,
  type Row,
  withDatabase,
} from '@/modules/database/tests/support/completion-notification-test-support.js';

test('v13 clamps legacy liveStop and direct valid JSON writes while completion policy remains all-off', () => {
  withDatabase((db) => {
    assert.deepEqual(all<{ version: number }>(db, 'SELECT version FROM schema_migrations ORDER BY version').map((row) => row.version),
      Array.from({ length: 20 }, (_, index) => index + 1));
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
