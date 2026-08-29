import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { runMigrations } from '@/modules/database/migrations.js';
import { INIT_SCHEMA_SQL } from '@/modules/database/schema.js';

export type Row = Record<string, unknown>;

export const get = <T extends Row>(
  db: Database.Database,
  sql: string,
  ...parameters: readonly unknown[]
): T | undefined => db.prepare(sql).get(...parameters) as T | undefined;

export const all = <T extends Row>(
  db: Database.Database,
  sql: string,
  ...parameters: readonly unknown[]
): T[] => db.prepare(sql).all(...parameters) as T[];

export const withDatabase = (run: (db: Database.Database) => void): void => {
  const db = new Database(':memory:');
  try {
    db.exec(INIT_SCHEMA_SQL);
    runMigrations(db);
    run(db);
  } finally {
    db.close();
  }
};

export const withRepositoryDatabase = (run: (db: Database.Database) => void): void => {
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

export const addUser = (db: Database.Database, id: number, name = `user-${id}`): void => {
  db.prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)')
    .run(id, name, 'hash');
};

export const addSubscription = (
  db: Database.Database,
  userId: number,
  endpoint = `https://push/${userId}`,
): void => {
  db.prepare(`INSERT INTO push_subscriptions (user_id, endpoint, keys_p256dh, keys_auth)
    VALUES (?, ?, 'key', 'auth')`).run(userId, endpoint);
};

export const enablePush = (db: Database.Database, userId: number): void => {
  db.prepare(`UPDATE completion_notification_policy
    SET desired_web_push = 1, enforcement_enabled = 1 WHERE user_id = ?`).run(userId);
};

export const enableCompletionPreferences = (
  db: Database.Database,
  userId: number,
  liveStop = true,
): void => {
  db.prepare('INSERT INTO user_notification_preferences (user_id, preferences_json) VALUES (?, ?)')
    .run(userId, JSON.stringify({ channels: { webPush: true }, events: { liveStop, stop: true } }));
};

export const payload = Object.freeze({
  title: 'Complete',
  body: 'Ready',
  navigation: Object.freeze({ href: '/sessions/demo', title: 'Complete' }),
});

export const appDecision = (
  userId: number,
  targetIdentityKey: string,
  sessionId = 'session-1',
) => ({
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
