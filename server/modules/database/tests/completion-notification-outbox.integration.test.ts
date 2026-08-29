import assert from 'node:assert/strict';
import test from 'node:test';

import { CompletionNotificationOutboxRepository } from '@/modules/database/repositories/completion-notification-outbox.js';
import { CompletionNotificationTargetsRepository } from '@/modules/database/repositories/completion-notification-targets.js';
import {
  addSubscription,
  addUser,
  enableCompletionPreferences,
  enablePush,
  get,
  payload,
  type Row,
  withDatabase,
} from '@/modules/database/tests/support/completion-notification-test-support.js';

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

test('a sent-but-unacknowledged delivery is terminal and cannot be reclaimed', () => {
  withDatabase((db) => {
    addUser(db, 1);
    addSubscription(db, 1);
    enablePush(db, 1);
    db.prepare(`INSERT INTO completion_notification_outbox
      (decision_id, decision_key, user_id, event_code, target_alias_snapshot, payload_json, notification_tag)
      VALUES ('sent-decision', 'sent-key', 1, 'reply_ready', 'target', '{}', 'tag')`).run();
    const outboxId = get<{ id: number }>(db,
      "SELECT id FROM completion_notification_outbox WHERE decision_id = 'sent-decision'")!.id;
    db.prepare(`INSERT INTO completion_notification_deliveries
      (outbox_id, subscription_id, subscription_id_at_creation, endpoint_owner_id, endpoint_snapshot, next_due_at)
      VALUES (?, 1, 1, 1, 'https://push/1', 0)`).run(outboxId);
    const outbox = new CompletionNotificationOutboxRepository(db);
    const claim = outbox.claimDue(0, 1, 10)[0]!;
    assert.equal(outbox.prepareSend(claim.id, claim.claimToken), true);
    assert.equal(outbox.sentUnacknowledged(claim.id, claim.claimToken), true);
    assert.deepEqual(get<{ state: string; error_class: string }>(db,
      'SELECT state, error_class FROM completion_notification_deliveries WHERE id = ?', claim.id),
    { state: 'permanent_failed', error_class: 'sent_unacknowledged' });
    assert.deepEqual(outbox.claimDue(10_000, 1, 10), []);
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

