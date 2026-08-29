import { watch } from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

import { completionAppIdentityKey } from '@/modules/database/index.js';

import type { Task23Fleet } from './task-23-driver.js';

export function configureTask23Notifications(fleet: Task23Fleet, sessionId: string): void {
  const configureOwner = (databasePath: string, peer: boolean) => {
    const db = new Database(databasePath);
    try {
      db.prepare("INSERT OR IGNORE INTO users (id, username, password_hash) VALUES (1, 'task23-owner', 'none')").run();
      if (peer) {
        const identity = completionAppIdentityKey({ provider: 'codex', sessionId });
        db.prepare("INSERT OR IGNORE INTO completion_notification_targets (identity_key, kind) VALUES (?, 'app')").run(identity);
        const target = db.prepare('SELECT id FROM completion_notification_targets WHERE identity_key = ?').get(identity) as { id: number };
        db.prepare('INSERT OR IGNORE INTO completion_notification_watches (user_id, target_id) VALUES (1, ?)').run(target.id);
      } else {
        db.prepare(`INSERT OR IGNORE INTO completion_notification_policy
          (user_id, desired_web_push, consent_configured, enforcement_enabled) VALUES (1, 1, 1, 1)`).run();
        db.prepare('UPDATE completion_notification_policy SET desired_web_push = 1, enforcement_enabled = 1 WHERE user_id = 1').run();
        db.prepare(`INSERT INTO user_notification_preferences (user_id, preferences_json) VALUES (1, ?)
          ON CONFLICT(user_id) DO UPDATE SET preferences_json = excluded.preferences_json`)
          .run(JSON.stringify({ channels: { webPush: true }, events: { stop: true, liveStop: true } }));
      }
    } finally { db.close(); }
  };
  configureOwner(fleet.harness.hub.databasePath, false);
  configureOwner(fleet.harness.peers.a.databasePath, true);
}

export function armTask23Outbox(databasePath: string, hostId: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const check = () => {
      const db = new Database(databasePath, { readonly: true });
      try {
        const rows = db.prepare('SELECT payload_json FROM completion_notification_outbox ORDER BY id').all() as Array<{ payload_json: string }>;
        const payload = rows.map((row) => JSON.parse(row.payload_json) as Record<string, unknown>)
          .find((row) => JSON.stringify(row).includes(hostId));
        if (payload !== undefined) finish(payload);
      } finally { db.close(); }
    };
    const watcher = watch(path.dirname(databasePath), check);
    const timeout = setTimeout(() => { watcher.close(); reject(new Error('hub outbox event timed out')); }, 20_000);
    const finish = (payload: Record<string, unknown>) => { clearTimeout(timeout); watcher.close(); resolve(payload); };
    watcher.once('error', (error) => { clearTimeout(timeout); watcher.close(); reject(error); });
    check();
  });
}
