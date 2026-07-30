/**
 * Notification preferences repository.
 *
 * Stores per-user notification channel/event preferences as JSON.
 */

import { getConnection } from '@/modules/database/connection.js';

type NotificationPreferences = {
  channels: {
    inApp: boolean;
    webPush: boolean;
    sound: boolean;
    [key: string]: boolean;
  };
  events: {
    actionRequired: boolean;
    stop: boolean;
    // GJC and external tmux CLI turn completion; separate from web-run stop.
    liveStop: boolean;
    error: boolean;
  };
};
export type CompletionPreferenceUpdate = {
  preferences: NotificationPreferences;
  wakeDispatcher: boolean;
};


const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  channels: {
    inApp: false,
    webPush: false,
    sound: true,
  },
  events: {
    actionRequired: true,
    stop: true,
    liveStop: false,
    error: true,
  },
};

function normalizeNotificationPreferences(value: unknown): NotificationPreferences {
  const source = value && typeof value === 'object' ? (value as Record<string, any>) : {};
  const sourceChannels = source.channels && typeof source.channels === 'object'
    ? source.channels as Record<string, unknown>
    : {};
  const extraChannels = Object.fromEntries(
    Object.entries(sourceChannels)
      .filter(([key, channelValue]) => !['inApp', 'webPush', 'desktop', 'sound'].includes(key) && typeof channelValue === 'boolean')
  ) as Record<string, boolean>;

  return {
    channels: {
      ...extraChannels,
      inApp: source.channels?.inApp === true,
      webPush: source.channels?.webPush === true,
      sound: source.channels?.sound !== false,
    },
    events: {
      actionRequired: source.events?.actionRequired !== false,
      stop: source.events?.stop !== false,
      liveStop: false,
      error: source.events?.error !== false,
    },
  };
}

export const notificationPreferencesDb = {
  /** Returns the normalized preferences for a user, creating defaults on first read. */
  getNotificationPreferences(userId: number): NotificationPreferences {
    const db = getConnection();
    const row = db
      .prepare(
        'SELECT preferences_json FROM user_notification_preferences WHERE user_id = ?'
      )
      .get(userId) as { preferences_json: string } | undefined;

    if (!row) {
      const defaults = normalizeNotificationPreferences(DEFAULT_NOTIFICATION_PREFERENCES);
      db.prepare(
        'INSERT INTO user_notification_preferences (user_id, preferences_json, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)'
      ).run(userId, JSON.stringify(defaults));
      return defaults;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(row.preferences_json);
    } catch (error) {
      throw new Error('stored notification preferences contain invalid JSON', { cause: error });
    }
    return normalizeNotificationPreferences(parsed);
  },

  /**
   * Persists the user-facing consent, delivery policy, and queued-delivery
   * transition as one SQLite transaction. Callers may wake a dispatcher only
   * after this method returns.
   */
  updateCompletionPreferencesAndDeliveryState(
    userId: number,
    preferences: unknown,
    now: number,
    configureWebPushConsent = false,
  ): CompletionPreferenceUpdate {
    const source = preferences && typeof preferences === 'object'
      ? preferences as Record<string, unknown>
      : {};
    const sourceChannels = source.channels && typeof source.channels === 'object'
      ? source.channels as Record<string, unknown>
      : {};
    const hasWebPush = Object.hasOwn(sourceChannels, 'webPush');
    const requestedWebPush = sourceChannels.webPush;
    if (hasWebPush && typeof requestedWebPush !== 'boolean') {
      throw new TypeError('channels.webPush must be a boolean when provided');
    }
    const explicitWebPushConsent = configureWebPushConsent === true;
    const db = getConnection();
    return db.transaction(() => {
      const stored = db.prepare(
        'SELECT preferences_json FROM user_notification_preferences WHERE user_id = ?',
      ).get(userId) as { preferences_json: string } | undefined;
      let current: NotificationPreferences;
      if (!stored) {
        current = normalizeNotificationPreferences(DEFAULT_NOTIFICATION_PREFERENCES);
      } else {
        let parsed: unknown;
        try {
          parsed = JSON.parse(stored.preferences_json);
        } catch (error) {
          throw new Error('stored notification preferences contain invalid JSON', { cause: error });
        }
        current = normalizeNotificationPreferences(parsed);
      }
      const normalized = normalizeNotificationPreferences({
        ...current,
        ...source,
        channels: { ...current.channels, ...sourceChannels },
        events: {
          ...current.events,
          ...(source.events && typeof source.events === 'object'
            ? source.events as Record<string, unknown>
            : {}),
        },
      });
      const policy = db.prepare(`SELECT desired_web_push, consent_configured, enforcement_enabled
        FROM completion_notification_policy WHERE user_id = ?`).get(userId) as {
        desired_web_push: number; consent_configured: number; enforcement_enabled: number;
      } | undefined;
      // Consent is proven once per device setup by the click-gated subscribe
      // route. Only a fresh enable needs that proof: a settings save that
      // round-trips an already-consented `true` is not a new enable, and
      // rejecting it would fail every unrelated preference write.
      if (requestedWebPush === true && !explicitWebPushConsent && !policy?.consent_configured) {
        throw new Error('enabling Web Push requires explicit click consent');
      }
      const wasEnabled = Boolean(policy?.desired_web_push && policy.enforcement_enabled);
      const desiredWebPush = requestedWebPush === false
        ? 0
        : requestedWebPush === true
          ? 1
          : (policy?.desired_web_push ?? 0);
      const enforcementEnabled = policy?.enforcement_enabled ?? 1;
      db.prepare(
        `INSERT INTO user_notification_preferences (user_id, preferences_json, updated_at)
         VALUES (?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(user_id) DO UPDATE SET
           preferences_json = excluded.preferences_json,
           updated_at = CURRENT_TIMESTAMP`,
      ).run(userId, JSON.stringify(normalized));
      db.prepare(`INSERT INTO completion_notification_policy (
        user_id, desired_web_push, consent_configured, enforcement_enabled
      ) VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET
        desired_web_push = excluded.desired_web_push,
        consent_configured = CASE WHEN ? THEN 1 ELSE consent_configured END,
        enforcement_enabled = completion_notification_policy.enforcement_enabled,
        updated_at = CURRENT_TIMESTAMP`)
        .run(
          userId,
          desiredWebPush,
          explicitWebPushConsent ? 1 : 0,
          enforcementEnabled,
          explicitWebPushConsent ? 1 : 0,
        );
      if (requestedWebPush === true && enforcementEnabled) {
        db.prepare(`UPDATE completion_notification_deliveries SET state = 'pending', next_due_at = ?,
          claim_token = NULL, claim_expires_at = NULL, updated_at = CURRENT_TIMESTAMP
          WHERE endpoint_owner_id = ? AND state = 'paused_global'`).run(now, userId);
      } else if (requestedWebPush === false) {
        db.prepare(`UPDATE completion_notification_deliveries SET state = 'paused_global', claim_token = NULL,
          claim_expires_at = NULL, updated_at = CURRENT_TIMESTAMP
          WHERE endpoint_owner_id = ? AND state IN ('pending', 'claimed', 'transient_retry')`).run(userId);
      }
      return {
        preferences: normalized,
        wakeDispatcher: requestedWebPush === true && enforcementEnabled === 1 && !wasEnabled,
      };
    })();
  },
  /** Reads completion delivery consent without creating or changing any preference row. */
  isCompletionGlobalPaused(userId: number): boolean {
    const row = getConnection().prepare(`
      SELECT desired_web_push, enforcement_enabled
      FROM completion_notification_policy
      WHERE user_id = ?
    `).get(userId) as { desired_web_push: number; enforcement_enabled: number } | undefined;
    return !row || !row.desired_web_push || !row.enforcement_enabled;
  },
  /** Returns whether browser click setup still needs explicit Web Push consent. */
  isCompletionWebPushSetupRequired(userId: number): boolean {
    const row = getConnection().prepare(`
      SELECT consent_configured
      FROM completion_notification_policy
      WHERE user_id = ?
    `).get(userId) as { consent_configured: number } | undefined;
    return !row || !row.consent_configured;
  },
  /** Legacy read alias used by existing services/routes. */
  getPreferences(userId: number): NotificationPreferences {
    return notificationPreferencesDb.getNotificationPreferences(userId);
  },

};
