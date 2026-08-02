import crypto from 'crypto';

import Database from 'better-sqlite3';

import { getConnection } from '@/modules/database/connection.js';
import {
  closeCompletionDeliveriesForEndpoint,
} from '@/modules/database/repositories/push-subscriptions.js';
import { completionAppIdentityKey } from '@/modules/database/services/completion-target-identity.service.js';
import { resolveCanonicalCompletionTarget } from '@/modules/database/repositories/completion-notification-targets.js';

import type {
  CompletionNotificationDeliveryState,
  CompletionNotificationEventCode,
  CompletionNotificationPayload,
} from '../../../../shared/completion-notifications.js';

export type TerminalCompletionDecision = {
  generationTargetId: number;
  evidenceCursor: string;
  eventCode: CompletionNotificationEventCode;
  targetAliasSnapshot: string;
  payload: Omit<CompletionNotificationPayload, 'tag'>;
  now: number;
};
export type TerminalCompletionDecisionResult = Readonly<{
  status: 'baselined' | 'decided' | 'replay';
  decisionIds: number[];
}>;
export type ApplicationCompletionDecision = {
  userId: number;
  preferenceClass: 'stop' | 'liveStop';
  targetIdentityKey: string;
  provider: string;
  sessionId: string;
  eventOccurrenceKey: string;
  eventCode: CompletionNotificationEventCode;
  targetAliasSnapshot: string;
  payload: Omit<CompletionNotificationPayload, 'tag'>;
  now: number;
};

type CreateCompletionDecision = {
  decisionId: string;
  decisionKey: string;
  userId: number;
  eventCode: CompletionNotificationEventCode;
  canonicalTargetId: number | null;
  targetAliasSnapshot: string;
  payload: Omit<CompletionNotificationPayload, 'tag'>;
  now: number;
};

export type ClaimedCompletionDelivery = {
  id: number;
  outboxId: number;
  claimToken: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  payload: CompletionNotificationPayload;
  attemptCount: number;
};


export class CompletionNotificationOutboxRepository {
  constructor(private readonly suppliedDb?: Database.Database) {}

  private get db(): Database.Database {
    return this.suppliedDb ?? getConnection();
  }

  /**
   * Atomically baselines an unarmed terminal generation or consumes its durable
   * running arm to make the terminal decision. This remains authoritative across
   * monitor restarts.
   */
  recordTerminalDecision(input: TerminalCompletionDecision): TerminalCompletionDecisionResult {
    return this.db.transaction((): TerminalCompletionDecisionResult => {
      const state = this.db.prepare(`SELECT generation.high_water_seq, generation.armed_seq, generation.monitor_state,
        generation.last_evidence_cursor
        FROM completion_notification_generation_state generation
        JOIN completion_notification_targets target ON target.id = generation.generation_target_id
        WHERE generation.generation_target_id = ? AND target.kind = 'external_generation'`)
        .get(input.generationTargetId) as {
          high_water_seq: number; armed_seq: number | null; monitor_state: string;
          last_evidence_cursor: string | null;
        } | undefined;
      if (!state) {
        const target = this.db.prepare('SELECT kind FROM completion_notification_targets WHERE id = ?')
          .get(input.generationTargetId) as { kind: string } | undefined;
        if (!target) throw new Error('terminal completion decision could not resolve canonical target');
        if (target.kind !== 'external_generation') throw new Error('terminal completion decision requires generation state');
        this.db.prepare(`INSERT INTO completion_notification_generation_state
          (generation_target_id, monitor_state, last_evidence_cursor)
          VALUES (?, 'terminal', ?)`).run(input.generationTargetId, input.evidenceCursor);
        return { status: 'baselined', decisionIds: [] };
      }
      const canonical = resolveCanonicalCompletionTarget(this.db, input.generationTargetId);
      if (!canonical) throw new Error('terminal completion decision could not resolve canonical target');
      const sequence = state.monitor_state === 'terminal' ? state.high_water_seq : state.armed_seq;
      // The same provider conversation can be visible through multiple tmux
      // panes. Key completion decisions by the conversation and exact terminal
      // transcript evidence, not by the pane/process generation that observed it.
      const decisionKey = sequence === null
        ? null
        : JSON.stringify([canonical.identity_key, input.evidenceCursor, input.eventCode]);
      if (state.monitor_state === 'terminal' && state.last_evidence_cursor === input.evidenceCursor) {
        return {
          status: 'replay',
          decisionIds: decisionKey === null ? [] : (this.db.prepare(`SELECT id FROM completion_notification_outbox
            WHERE decision_key = ? ORDER BY user_id, id`).all(decisionKey) as Array<{ id: number }>).map(({ id }) => id),
        };
      }
      if (state.monitor_state !== 'running' || sequence === null || state.last_evidence_cursor === input.evidenceCursor) {
        this.db.prepare(`UPDATE completion_notification_generation_state
          SET armed_seq = NULL, monitor_state = 'terminal', last_evidence_cursor = ?,
              state_revision = state_revision + 1, updated_at = CURRENT_TIMESTAMP
          WHERE generation_target_id = ?`).run(input.evidenceCursor, input.generationTargetId);
        return { status: 'baselined', decisionIds: [] };
      }
      const replay = this.db.prepare(`SELECT id FROM completion_notification_outbox
        WHERE decision_key = ? ORDER BY user_id, id`).all(decisionKey) as Array<{ id: number }>;
      if (replay.length > 0) {
        const disarmed = this.db.prepare(`UPDATE completion_notification_generation_state
          SET armed_seq = NULL, monitor_state = 'terminal', last_evidence_cursor = ?,
              state_revision = state_revision + 1, updated_at = CURRENT_TIMESTAMP
          WHERE generation_target_id = ? AND armed_seq = ? AND monitor_state = 'running'`)
          .run(input.evidenceCursor, input.generationTargetId, sequence).changes;
        if (disarmed !== 1) throw new Error('terminal completion decision lost armed generation compare-and-swap');
        return { status: 'replay', decisionIds: replay.map(({ id }) => id) };
      }
      const owners = this.db.prepare(`SELECT DISTINCT watch.user_id
        FROM completion_notification_watches watch
        JOIN user_notification_preferences preference ON preference.user_id = watch.user_id
        JOIN completion_notification_policy policy ON policy.user_id = watch.user_id
        WHERE watch.target_id = ?
          AND policy.desired_web_push = 1 AND policy.enforcement_enabled = 1
          AND json_extract(preference.preferences_json, '$.channels.webPush') = 1
        ORDER BY watch.user_id`)
        .all(canonical.id) as Array<{ user_id: number }>;
      const subscriptions = this.db.prepare(`SELECT id, user_id, endpoint
        FROM push_subscriptions WHERE user_id IN (
          SELECT user_id FROM completion_notification_watches WHERE target_id = ?
        ) ORDER BY user_id, id`).all(canonical.id) as Array<{ id: number; user_id: number; endpoint: string }>;
      const disarmed = this.db.prepare(`UPDATE completion_notification_generation_state
        SET armed_seq = NULL, monitor_state = 'terminal', last_evidence_cursor = ?,
            state_revision = state_revision + 1, updated_at = CURRENT_TIMESTAMP
        WHERE generation_target_id = ? AND armed_seq = ? AND monitor_state = 'running'`)
        .run(input.evidenceCursor, input.generationTargetId, sequence).changes;
      if (disarmed !== 1) throw new Error('terminal completion decision lost armed generation compare-and-swap');
      return {
        status: 'decided',
        decisionIds: owners.map(({ user_id }) => this.insertDecision({
          decisionId: crypto.randomUUID(),
          decisionKey: decisionKey!,
          userId: user_id,
          eventCode: input.eventCode,
          canonicalTargetId: canonical.id,
          targetAliasSnapshot: input.targetAliasSnapshot,
          payload: input.payload,
          now: input.now,
        }, subscriptions.filter((subscription) => subscription.user_id === user_id))),
      };
    })();
  }

  createTerminalDecision(input: TerminalCompletionDecision): number[] {
    return this.recordTerminalDecision(input).decisionIds;
  }
  /**
   * Creates an app decision only after the producer owner's preference, stable
   * replay, global policy, canonical watch, and active app target gates pass.
   */
  createApplicationDecision(input: ApplicationCompletionDecision): number[] {
    const canonicalIdentityKey = completionAppIdentityKey({
      provider: input.provider,
      sessionId: input.sessionId,
    });
    if (input.targetIdentityKey !== canonicalIdentityKey) {
      throw new TypeError('application target identity does not match provider and session');
    }
    return this.db.transaction(() => {
      const preference = this.db.prepare(`SELECT 1 FROM user_notification_preferences
        WHERE user_id = ?
          AND json_extract(preferences_json, '$.channels.webPush') = 1
          AND (? = 'liveStop' OR json_extract(preferences_json, '$.events.stop') = 1)`)
        .get(input.userId, input.preferenceClass);
      if (!preference) return [];

      const decisionKey = JSON.stringify([input.targetIdentityKey, input.eventOccurrenceKey, input.eventCode]);
      const replay = this.db.prepare(`SELECT id FROM completion_notification_outbox
        WHERE user_id = ? AND decision_key = ? ORDER BY id`)
        .all(input.userId, decisionKey) as Array<{ id: number }>;
      if (replay.length > 0) return replay.map(({ id }) => id);

      const policy = this.db.prepare(`SELECT 1 FROM completion_notification_policy
        WHERE user_id = ? AND desired_web_push = 1 AND enforcement_enabled = 1`)
        .get(input.userId);
      if (!policy) return [];

      const target = this.db.prepare('SELECT id FROM completion_notification_targets WHERE identity_key = ?')
        .get(input.targetIdentityKey) as { id: number } | undefined;
      const canonical = target && resolveCanonicalCompletionTarget(this.db, target.id);
      if (!canonical || canonical.kind !== 'app') return [];

      const watch = this.db.prepare(`SELECT 1 FROM completion_notification_watches
        WHERE user_id = ? AND target_id = ?`).get(input.userId, canonical.id);
      if (!watch) return [];

      const activeTarget = this.db.prepare(`SELECT 1 FROM sessions session
        JOIN projects project ON project.project_path = session.project_path
        WHERE session.session_id = ? AND session.provider = ? LIMIT 1`)
        .get(input.sessionId, input.provider);
      if (!activeTarget) return [];

      const subscriptions = this.db.prepare(`SELECT id, user_id, endpoint FROM push_subscriptions
        WHERE user_id = ? ORDER BY id`).all(input.userId) as Array<{ id: number; user_id: number; endpoint: string }>;
      return [this.insertDecision({
        decisionId: crypto.randomUUID(),
        decisionKey,
        userId: input.userId,
        eventCode: input.eventCode,
        canonicalTargetId: canonical.id,
        targetAliasSnapshot: input.targetAliasSnapshot,
        payload: input.payload,
        now: input.now,
      }, subscriptions)];
    })();
  }

  private insertDecision(input: CreateCompletionDecision, subscriptions: Array<{ id: number; user_id: number; endpoint: string }>): number {
    const notificationTag = `completion:${input.decisionId}`;
    const payload = { ...input.payload, tag: notificationTag };
    this.db.prepare(`INSERT INTO completion_notification_outbox
      (decision_id, decision_key, user_id, event_code, canonical_target_id, target_alias_snapshot, payload_json, notification_tag)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      input.decisionId, input.decisionKey, input.userId, input.eventCode, input.canonicalTargetId,
      input.targetAliasSnapshot, JSON.stringify(payload), notificationTag,
    );
    const outbox = this.db.prepare('SELECT id FROM completion_notification_outbox WHERE decision_id = ?')
      .get(input.decisionId) as { id: number };
    const insertDelivery = this.db.prepare(`INSERT INTO completion_notification_deliveries
      (outbox_id, subscription_id, subscription_id_at_creation, endpoint_owner_id, endpoint_snapshot, state, next_due_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?)`);
    for (const subscription of subscriptions) {
      insertDelivery.run(outbox.id, subscription.id, subscription.id, subscription.user_id, subscription.endpoint, input.now);
    }
    return outbox.id;
  }

  claimDue(now: number, limit = 100, leaseMs = 30_000): ClaimedCompletionDelivery[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('claim limit must be between 1 and 100');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const due = this.db.prepare(`SELECT delivery.id FROM completion_notification_deliveries delivery
        JOIN completion_notification_outbox outbox ON outbox.id = delivery.outbox_id
        JOIN push_subscriptions subscription ON subscription.id = delivery.subscription_id
        JOIN completion_notification_policy policy ON policy.user_id = outbox.user_id
        WHERE subscription.user_id = delivery.endpoint_owner_id
          AND policy.desired_web_push = 1 AND policy.enforcement_enabled = 1
          AND ((delivery.state IN ('pending', 'transient_retry') AND delivery.next_due_at <= ?)
            OR (delivery.state = 'claimed' AND delivery.claim_expires_at <= ?))
        ORDER BY outbox.created_at, outbox.id, delivery.id LIMIT ?`).all(now, now, limit) as Array<{ id: number }>;
      const claim = this.db.prepare(`UPDATE completion_notification_deliveries SET state = 'claimed',
        claim_token = ?, claim_expires_at = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND ((state IN ('pending', 'transient_retry') AND next_due_at <= ?)
          OR (state = 'claimed' AND claim_expires_at <= ?))
        AND EXISTS (SELECT 1 FROM completion_notification_outbox outbox
          JOIN completion_notification_policy policy ON policy.user_id = outbox.user_id
          WHERE outbox.id = completion_notification_deliveries.outbox_id
            AND policy.desired_web_push = 1 AND policy.enforcement_enabled = 1)`);
      const read = this.db.prepare(`SELECT delivery.id, delivery.outbox_id, delivery.claim_token, delivery.endpoint_snapshot,
          delivery.attempt_count, outbox.payload_json, subscription.keys_p256dh, subscription.keys_auth
        FROM completion_notification_deliveries delivery JOIN completion_notification_outbox outbox ON outbox.id = delivery.outbox_id
        JOIN push_subscriptions subscription ON subscription.id = delivery.subscription_id
        WHERE delivery.id = ? AND delivery.claim_token = ?`);
      const claimed: ClaimedCompletionDelivery[] = [];
      for (const row of due) {
        const token = crypto.randomUUID();
        if (claim.run(token, now + leaseMs, row.id, now, now).changes !== 1) continue;
        const delivery = read.get(row.id, token) as {
          id: number; outbox_id: number; claim_token: string; endpoint_snapshot: string; attempt_count: number;
          payload_json: string; keys_p256dh: string; keys_auth: string;
        };
        claimed.push({ id: delivery.id, outboxId: delivery.outbox_id, claimToken: delivery.claim_token,
          endpoint: delivery.endpoint_snapshot, p256dh: delivery.keys_p256dh, auth: delivery.keys_auth,
          attemptCount: delivery.attempt_count, payload: JSON.parse(delivery.payload_json) as CompletionNotificationPayload });
      }
      this.db.exec('COMMIT');
      return claimed;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  acknowledge(deliveryId: number, claimToken: string, now: number): boolean {
    return this.finishClaim(deliveryId, claimToken, `state = 'acknowledged', acknowledged_at = ?, error_class = NULL`, [now]);
  }

  /** A sent push whose acknowledgement could not be persisted must never be reclaimed. */
  sentUnacknowledged(deliveryId: number, claimToken: string): boolean {
    return this.finishClaim(
      deliveryId,
      claimToken,
      `state = 'permanent_failed', error_class = 'sent_unacknowledged'`,
      [],
    );
  }
  /**
   * Call immediately before transport. A paused policy wins the token CAS and
   * does not consume an attempt; only a permitted transport increments it.
   */
  prepareSend(deliveryId: number, claimToken: string): boolean {
    return this.db.transaction(() => {
      const permitted = this.db.prepare(`UPDATE completion_notification_deliveries
        SET attempt_count = attempt_count + 1, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND state = 'claimed' AND claim_token = ?
          AND EXISTS (SELECT 1 FROM completion_notification_outbox outbox
            JOIN completion_notification_policy policy ON policy.user_id = outbox.user_id
            WHERE outbox.id = completion_notification_deliveries.outbox_id
              AND policy.desired_web_push = 1 AND policy.enforcement_enabled = 1)`)
        .run(deliveryId, claimToken).changes === 1;
      if (permitted) return true;
      this.db.prepare(`UPDATE completion_notification_deliveries SET state = 'paused_global',
        claim_token = NULL, claim_expires_at = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND state = 'claimed' AND claim_token = ?`).run(deliveryId, claimToken);
      return false;
    })();
  }


  retry(deliveryId: number, claimToken: string, nextDueAt: number, errorClass: string): boolean {
    return this.finishClaim(deliveryId, claimToken,
      `state = 'transient_retry', next_due_at = ?, error_class = ?`, [nextDueAt, errorClass]);
  }

  permanentFailure(deliveryId: number, claimToken: string, errorClass: string): boolean {
    return this.finishClaim(deliveryId, claimToken, `state = 'permanent_failed', error_class = ?`, [errorClass]);
  }

  endpointGone(deliveryId: number, claimToken: string, _now?: number): boolean {
    return this.db.transaction(() => {
      const delivery = this.db.prepare(`SELECT endpoint_owner_id, endpoint_snapshot FROM completion_notification_deliveries
        WHERE id = ? AND state = 'claimed' AND claim_token = ?`).get(deliveryId, claimToken) as { endpoint_owner_id: number; endpoint_snapshot: string } | undefined;
      if (!delivery) return false;
      closeCompletionDeliveriesForEndpoint(this.db, delivery.endpoint_owner_id, delivery.endpoint_snapshot);
      this.db.prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?')
        .run(delivery.endpoint_owner_id, delivery.endpoint_snapshot);
      return true;
    })();
  }

  getDeliveryState(deliveryId: number): CompletionNotificationDeliveryState | undefined {
    return (this.db.prepare('SELECT state FROM completion_notification_deliveries WHERE id = ?').get(deliveryId) as { state: CompletionNotificationDeliveryState } | undefined)?.state;
  }

  private finishClaim(deliveryId: number, claimToken: string, setClause: string, values: unknown[]): boolean {
    const result = this.db.prepare(`UPDATE completion_notification_deliveries SET ${setClause}, claim_token = NULL,
      claim_expires_at = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND state = 'claimed' AND claim_token = ?`).run(...values, deliveryId, claimToken);
    return result.changes === 1;
  }
}

export const completionNotificationOutboxDb = new CompletionNotificationOutboxRepository();
