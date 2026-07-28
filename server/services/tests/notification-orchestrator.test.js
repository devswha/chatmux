import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import webPush from 'web-push';

import {
  closeConnection,
  completionAppAlias,
  completionAppIdentityKey,
  completionNotificationTargetsDb,
  getConnection,
  initializeDatabase,
  notificationPreferencesDb,
  pushSubscriptionsDb,
  sessionsDb,
  userDb,
} from '../../modules/database/index.js';
import { notifyLiveTurnEnded, notifyRunStopped } from '../notification-orchestrator.js';

async function withIsolatedDatabase(runTest) {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'notification-orchestrator-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

function enableCompletionTarget(userId, provider, appSessionId) {
  const identity = { provider, sessionId: appSessionId };
  const alias = completionAppAlias(identity);
  const target = completionNotificationTargetsDb.createTarget(
    completionAppIdentityKey(identity),
    'app',
    [alias],
  );
  completionNotificationTargetsDb.setWatch(userId, {
    mutationId: `watch-${userId}-${appSessionId}`,
    alias,
    expectedRevision: target.revision,
    watched: true,
  });
  getConnection().prepare(`UPDATE completion_notification_policy
    SET desired_web_push = 1, enforcement_enabled = 1 WHERE user_id = ?`).run(userId);
}

test('push payload uses the app session id when notified with a provider session id', async () => {
  const originalSendNotification = webPush.sendNotification;
  const sentPayloads = [];

  webPush.sendNotification = async (_subscription, payload) => {
    sentPayloads.push(JSON.parse(payload));
    return {};
  };

  try {
    await withIsolatedDatabase(async () => {
      const user = userDb.createUser('notify-user', 'hash');
      const userId = Number(user.id);

      notificationPreferencesDb.updateCompletionPreferencesAndDeliveryState(userId, {
        channels: { webPush: true },
        events: { actionRequired: true, stop: true, liveStop: true, error: true },
      }, Date.now(), true);
      pushSubscriptionsDb.saveSubscription(userId, 'https://example.test/push', 'p256dh', 'auth');
      sessionsDb.createAppSession('app-session-1', 'claude', '/workspace/demo');
      sessionsDb.assignProviderSessionId('app-session-1', 'claude', 'claude-native-1');
      enableCompletionTarget(userId, 'claude', 'app-session-1');

      notifyRunStopped({
        userId,
        provider: 'claude',
        sessionId: 'claude-native-1',
        stopReason: 'completed',
        completionKey: 'app-generation:1',
      });

      const outbox = getConnection().prepare(
        'SELECT payload_json FROM completion_notification_outbox ORDER BY id',
      ).all();
      const [payload] = outbox.map((row) => JSON.parse(row.payload_json));

      assert.equal(outbox.length, 1);
      assert.equal(payload?.navigation?.href, `/session/${encodeURIComponent('app-session-1')}`);
      assert.equal(payload?.navigation?.title, 'ChatMux');
      assert.equal(sentPayloads.length, 0, 'completion producers only create durable outbox decisions');
    });
  } finally {
    webPush.sendNotification = originalSendNotification;
  }
});

test('live-GJC completion producer rejects non-GJC targets before policy lookup', () => {
  assert.throws(() => notifyLiveTurnEnded({
    userId: 1,
    provider: 'claude',
    sessionId: 'external-session',
    tmuxName: 'external-run',
    completionKey: 'external-generation:1',
  }), RangeError);
});
test('completion producers reject malformed completed input but silently exclude non-completed stops', () => {
  assert.throws(() => notifyRunStopped({
    userId: 1, provider: 'claude', sessionId: 'session', stopReason: 'completed',
  }), TypeError);
  assert.throws(() => notifyLiveTurnEnded({
    userId: 1, provider: 'gjc', sessionId: 'session', stopReason: 'completed',
  }), TypeError);

  assert.doesNotThrow(() => notifyRunStopped({
    userId: null, provider: '', sessionId: null, stopReason: 'aborted',
  }));
  assert.doesNotThrow(() => notifyLiveTurnEnded({
    userId: null, sessionId: null, stopReason: 'manual_abort',
  }));
});
