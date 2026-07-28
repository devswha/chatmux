/** Push endpoints are owner-bound. Registration deliberately does not change notification policy. */
import Database from 'better-sqlite3';

import { getConnection } from '@/modules/database/connection.js';

export type PushSubscriptionLookupRow = {
  id: number;
  endpoint: string;
  keys_p256dh: string;
  keys_auth: string;
};

export type PushSubscriptionOwnershipConflict = 'endpoint_owned_by_another_user';

function ownershipConflict(): Error & { code: PushSubscriptionOwnershipConflict } {
  return Object.assign(new Error('push subscription endpoint is owned by another user'), {
    code: 'endpoint_owned_by_another_user' as const,
  });
}

export const OPEN_COMPLETION_DELIVERY_STATES = "('pending', 'claimed', 'transient_retry', 'paused_global')";

export function closeCompletionDeliveriesForEndpoint(
  db: Database.Database,
  userId: number,
  endpoint: string,
): number {
  return db.prepare(`UPDATE completion_notification_deliveries
    SET state = 'endpoint_removed', claim_token = NULL, claim_expires_at = NULL,
        error_class = 'endpoint_removed', updated_at = CURRENT_TIMESTAMP
    WHERE endpoint_owner_id = ? AND endpoint_snapshot = ?
      AND state IN ${OPEN_COMPLETION_DELIVERY_STATES}`).run(userId, endpoint).changes;
}

export function closeCompletionDeliveriesForUser(
  db: Database.Database,
  userId: number,
): number {
  return db.prepare(`UPDATE completion_notification_deliveries
    SET state = 'endpoint_removed', claim_token = NULL, claim_expires_at = NULL,
        error_class = 'endpoint_removed', updated_at = CURRENT_TIMESTAMP
    WHERE endpoint_owner_id = ? AND state IN ${OPEN_COMPLETION_DELIVERY_STATES}`).run(userId).changes;
}

export const pushSubscriptionsDb = {
  /**
   * Idempotently refreshes an endpoint owned by userId. An endpoint registered
   * to another user is never re-assigned by this operation.
   */
  createPushSubscription(
    userId: number,
    endpoint: string,
    keysP256dh: string,
    keysAuth: string,
  ): PushSubscriptionLookupRow {
    const db = getConnection();
    return db.transaction(() => {
      const existing = db.prepare(
        'SELECT id, user_id FROM push_subscriptions WHERE endpoint = ?',
      ).get(endpoint) as { id: number; user_id: number } | undefined;
      if (existing && existing.user_id !== userId) throw ownershipConflict();
      if (existing) {
        db.prepare(`UPDATE push_subscriptions
          SET keys_p256dh = ?, keys_auth = ?
          WHERE id = ? AND user_id = ?`).run(keysP256dh, keysAuth, existing.id, userId);
      } else {
        db.prepare(`INSERT INTO push_subscriptions (user_id, endpoint, keys_p256dh, keys_auth)
          VALUES (?, ?, ?, ?)`).run(userId, endpoint, keysP256dh, keysAuth);
      }
      const row = db.prepare(`SELECT id, endpoint, keys_p256dh, keys_auth
        FROM push_subscriptions WHERE endpoint = ? AND user_id = ?`).get(endpoint, userId) as PushSubscriptionLookupRow | undefined;
      if (!row) throw new Error('push subscription registration was not persisted');
      return row;
    })();
  },

  getPushSubscriptions(userId: number): PushSubscriptionLookupRow[] {
    return getConnection().prepare(
      'SELECT id, endpoint, keys_p256dh, keys_auth FROM push_subscriptions WHERE user_id = ?',
    ).all(userId) as PushSubscriptionLookupRow[];
  },

  /** Closes this owner's open deliveries and removes their endpoint atomically. */
  deletePushSubscriptionForUser(userId: number, endpoint: string): boolean {
    const db = getConnection();
    return db.transaction(() => {
      closeCompletionDeliveriesForEndpoint(db, userId, endpoint);
      const deleted = db.prepare(
        'DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?',
      ).run(userId, endpoint).changes > 0;
      return deleted;
    })();
  },

  /** Closes a user's open deliveries before removing all of their endpoints. */
  deletePushSubscriptionsForUser(userId: number): void {
    const db = getConnection();
    db.transaction(() => {
      closeCompletionDeliveriesForUser(db, userId);
      db.prepare('DELETE FROM push_subscriptions WHERE user_id = ?').run(userId);
    })();
  },

  saveSubscription(userId: number, endpoint: string, keysP256dh: string, keysAuth: string): PushSubscriptionLookupRow {
    return pushSubscriptionsDb.createPushSubscription(userId, endpoint, keysP256dh, keysAuth);
  },
  getSubscriptions(userId: number): PushSubscriptionLookupRow[] {
    return pushSubscriptionsDb.getPushSubscriptions(userId);
  },
  removeSubscriptionForUser(userId: number, endpoint: string): boolean {
    return pushSubscriptionsDb.deletePushSubscriptionForUser(userId, endpoint);
  },
  removeAllForUser(userId: number): void {
    pushSubscriptionsDb.deletePushSubscriptionsForUser(userId);
  },
};
