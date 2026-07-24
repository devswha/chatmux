import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import webPush from 'web-push';

import {
  closeConnection,
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

      notificationPreferencesDb.updatePreferences(userId, {
        channels: { webPush: true },
        events: { actionRequired: true, stop: true, error: true },
      });
      pushSubscriptionsDb.saveSubscription(userId, 'https://example.test/push', 'p256dh', 'auth');
      sessionsDb.createAppSession('app-session-1', 'claude', '/workspace/demo');
      sessionsDb.assignProviderSessionId('app-session-1', 'claude', 'claude-native-1');

      notifyRunStopped({
        userId,
        provider: 'claude',
        sessionId: 'claude-native-1',
        stopReason: 'completed',
      });

      await new Promise((resolve) => setImmediate(resolve));

      assert.equal(sentPayloads.length, 1);
      assert.equal(sentPayloads[0]?.data?.sessionId, 'app-session-1');
      assert.match(sentPayloads[0]?.data?.tag, /app-session-1/);
    });
  } finally {
    webPush.sendNotification = originalSendNotification;
  }
});

test('live turn notifications dedupe one completion but allow the next ordinal', async () => {
  const originalSendNotification = webPush.sendNotification;
  const sentPayloads = [];

  webPush.sendNotification = async (_subscription, payload) => {
    sentPayloads.push(JSON.parse(payload));
    return {};
  };

  try {
    await withIsolatedDatabase(async () => {
      const user = userDb.createUser('live-notify-user', 'hash');
      const userId = Number(user.id);
      notificationPreferencesDb.updatePreferences(userId, {
        channels: { webPush: true },
        events: { actionRequired: true, stop: true, liveStop: true, error: true },
      });
      pushSubscriptionsDb.saveSubscription(userId, 'https://example.test/live-push', 'p256dh', 'auth');

      const completion = {
        userId,
        provider: 'opencode',
        sessionId: 'opencode-native-1',
        tmuxName: 'mobile-run',
      };
      notifyLiveTurnEnded({ ...completion, completionKey: 'generation-a:1' });
      notifyLiveTurnEnded({ ...completion, completionKey: 'generation-a:1' });
      notifyLiveTurnEnded({ ...completion, completionKey: 'generation-a:2' });

      await new Promise((resolve) => setImmediate(resolve));

      assert.equal(sentPayloads.length, 2);
      assert.match(sentPayloads[0]?.body, /^OpenCode: Reply ready/);
      assert.equal(sentPayloads[0]?.title, 'mobile-run');
    });
  } finally {
    webPush.sendNotification = originalSendNotification;
  }
});

test('liveStop preference disables external completion push', async () => {
  const originalSendNotification = webPush.sendNotification;
  const sentPayloads = [];

  webPush.sendNotification = async (_subscription, payload) => {
    sentPayloads.push(JSON.parse(payload));
    return {};
  };

  try {
    await withIsolatedDatabase(async () => {
      const user = userDb.createUser('disabled-live-notify-user', 'hash');
      const userId = Number(user.id);
      notificationPreferencesDb.updatePreferences(userId, {
        channels: { webPush: true },
        events: { actionRequired: true, stop: true, liveStop: false, error: true },
      });
      pushSubscriptionsDb.saveSubscription(userId, 'https://example.test/disabled-live-push', 'p256dh', 'auth');

      notifyLiveTurnEnded({
        userId,
        provider: 'claude',
        sessionId: 'disabled-native-1',
        tmuxName: 'disabled-run',
        completionKey: 'disabled-generation:1',
      });
      await new Promise((resolve) => setImmediate(resolve));

      assert.equal(sentPayloads.length, 0);
    });
  } finally {
    webPush.sendNotification = originalSendNotification;
  }
});
