import assert from 'node:assert/strict';
import test from 'node:test';

import { CompletionNotificationOutboxRepository } from '@/modules/database/repositories/completion-notification-outbox.js';
import { CompletionNotificationTargetsRepository } from '@/modules/database/repositories/completion-notification-targets.js';
import { notificationPreferencesDb } from '@/modules/database/repositories/notification-preferences.js';
import { pushSubscriptionsDb } from '@/modules/database/repositories/push-subscriptions.js';
import { completionAppIdentityKey } from '@/modules/database/services/completion-target-identity.service.js';
import {
  addSubscription,
  addUser,
  get,
  payload,
  type Row,
  withRepositoryDatabase,
} from '@/modules/database/tests/support/completion-notification-test-support.js';

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
