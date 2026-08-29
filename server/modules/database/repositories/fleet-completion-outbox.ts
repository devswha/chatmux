import { randomUUID } from 'node:crypto';

import Database from 'better-sqlite3';

import { getConnection } from '@/modules/database/connection.js';

import type { CompletionNotificationPayload } from '../../../../shared/completion-notifications.js';
import {
  completionEventIdentityKey,
  type FleetCompletionReady,
} from '../../../../shared/fleet-completion.js';

export type FleetCompletionDecisionResult = Readonly<{
  readonly kind: 'created' | 'replay' | 'ignored';
  readonly decisionIds: readonly number[];
}>;

const PROVIDER_LABELS: Readonly<Record<string, string>> = {
  claude: 'Claude', cursor: 'Cursor', codex: 'Codex', opencode: 'OpenCode',
  omp: 'Oh My Pi', omo: 'Oh My OpenAgent', gjc: 'GJC', system: 'System',
};

function completionPayload(event: FleetCompletionReady): Omit<CompletionNotificationPayload, 'tag'> {
  const sessionId = event.target.kind === 'app' ? event.target.localId : event.target.appLocalId;
  const title = event.sessionLabel ?? 'ChatMux';
  return {
    title,
    body: `${event.hostLabel} · ${PROVIDER_LABELS[event.provider] ?? 'Assistant'}: Reply ready`,
    navigation: {
      href: sessionId === null
        ? '/'
        : `/hosts/${event.target.hostId}/session/${encodeURIComponent(sessionId)}`,
      title,
      hostId: event.target.hostId,
      sessionId,
    },
  };
}

export class FleetCompletionOutboxRepository {
  constructor(private readonly suppliedDb?: Database.Database) {}

  private get db(): Database.Database {
    return this.suppliedDb ?? getConnection();
  }

  record(userId: number, event: FleetCompletionReady, now: number): FleetCompletionDecisionResult {
    if (!Number.isSafeInteger(userId) || userId < 1) throw new TypeError('owner ID must be a positive integer');
    if (!Number.isSafeInteger(now) || now < 0) throw new TypeError('decision time must be a non-negative integer');
    const identityKey = completionEventIdentityKey(event);
    const decisionKey = JSON.stringify([identityKey, event.occurrenceKey, 'reply_ready']);
    return this.db.transaction((): FleetCompletionDecisionResult => {
      const replay = this.db.prepare(`SELECT id FROM completion_notification_outbox
        WHERE user_id = ? AND decision_key = ? ORDER BY id`).all(userId, decisionKey) as Array<{ id: number }>;
      if (replay.length > 0) return { kind: 'replay', decisionIds: replay.map(({ id }) => id) };

      const permitted = this.db.prepare(`SELECT 1 FROM completion_notification_policy policy
        JOIN user_notification_preferences preference ON preference.user_id = policy.user_id
        WHERE policy.user_id = ? AND policy.desired_web_push = 1 AND policy.enforcement_enabled = 1
          AND json_extract(preference.preferences_json, '$.channels.webPush') = 1
          AND (? = 'liveStop' OR json_extract(preference.preferences_json, '$.events.stop') = 1)`)
        .get(userId, event.preferenceClass);
      if (!permitted) return { kind: 'ignored', decisionIds: [] };

      const decisionId = randomUUID();
      const tag = `completion:${identityKey.slice(-32)}:${decisionId}`;
      const payload: CompletionNotificationPayload = { ...completionPayload(event), tag };
      this.db.prepare(`INSERT INTO completion_notification_outbox
        (decision_id, decision_key, user_id, event_code, canonical_target_id,
          target_alias_snapshot, payload_json, notification_tag)
        VALUES (?, ?, ?, 'reply_ready', NULL, ?, ?, ?)`).run(
        decisionId, decisionKey, userId, identityKey, JSON.stringify(payload), tag,
      );
      const outbox = this.db.prepare('SELECT id FROM completion_notification_outbox WHERE decision_id = ?')
        .get(decisionId) as { id: number };
      const subscriptions = this.db.prepare(`SELECT id, user_id, endpoint FROM push_subscriptions
        WHERE user_id = ? ORDER BY id`).all(userId) as Array<{ id: number; user_id: number; endpoint: string }>;
      const insert = this.db.prepare(`INSERT INTO completion_notification_deliveries
        (outbox_id, subscription_id, subscription_id_at_creation, endpoint_owner_id,
          endpoint_snapshot, state, next_due_at)
        VALUES (?, ?, ?, ?, ?, 'pending', ?)`);
      for (const subscription of subscriptions) {
        insert.run(outbox.id, subscription.id, subscription.id, subscription.user_id, subscription.endpoint, now);
      }
      return { kind: 'created', decisionIds: [outbox.id] };
    })();
  }
}

export const fleetCompletionOutboxDb = new FleetCompletionOutboxRepository();
