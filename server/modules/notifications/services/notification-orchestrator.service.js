import webPush from 'web-push';

import { notificationPreferencesDb, pushSubscriptionsDb, sessionsDb } from '@/modules/database/index.js';

const KIND_TO_PREF_KEY = {
  action_required: 'actionRequired',
  stop: 'stop',
  // tmux 라이브(외부 구동) gjc 세션의 턴 완료 — 웹 구동 완료(stop)와 분리
  // 토글: tmux 옆에서 작업 중일 땐 이것만 끌 수 있어야 한다.
  live_stop: 'liveStop',
  error: 'error'
};

const PROVIDER_LABELS = {
  claude: 'Claude',
  cursor: 'Cursor',
  codex: 'Codex',
  gjc: 'GJC',
  system: 'System'
};

const recentEventKeys = new Map();
const DEDUPE_WINDOW_MS = 20000;

const cleanupOldEventKeys = () => {
  const now = Date.now();
  for (const [key, timestamp] of recentEventKeys.entries()) {
    if (now - timestamp > DEDUPE_WINDOW_MS) {
      recentEventKeys.delete(key);
    }
  }
};

function isNotificationEventEnabled(preferences, event) {
  const prefEventKey = KIND_TO_PREF_KEY[event.kind];
  const eventEnabled = prefEventKey ? Boolean(preferences?.events?.[prefEventKey]) : true;

  return eventEnabled;
}

function isDuplicate(event) {
  cleanupOldEventKeys();
  const key = event.dedupeKey || `${event.provider}:${event.kind || 'info'}:${event.code || 'generic'}:${event.sessionId || 'none'}`;
  if (recentEventKeys.has(key)) {
    return true;
  }
  recentEventKeys.set(key, Date.now());
  return false;
}

function createNotificationEvent({
  provider,
  sessionId = null,
  kind = 'info',
  code = 'generic.info',
  meta = {},
  severity = 'info',
  dedupeKey = null,
  requiresUserAction = false
}) {
  return {
    provider,
    sessionId,
    kind,
    code,
    meta,
    severity,
    requiresUserAction,
    dedupeKey,
    createdAt: new Date().toISOString()
  };
}

function normalizeErrorMessage(error) {
  if (typeof error === 'string') {
    return error;
  }

  if (error && typeof error.message === 'string') {
    return error.message;
  }

  if (error == null) {
    return 'Unknown error';
  }

  return String(error);
}

function normalizeSessionName(sessionName) {
  if (typeof sessionName !== 'string') {
    return null;
  }

  const normalized = sessionName.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return null;
  }

  return normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized;
}

function rowMatchesProvider(row, provider) {
  return row && (!provider || row.provider === provider);
}

function resolveSessionRow(sessionId, provider) {
  if (!sessionId) {
    return null;
  }

  const appSessionRow = sessionsDb.getSessionById(sessionId);
  if (rowMatchesProvider(appSessionRow, provider)) {
    return appSessionRow;
  }

  const providerSessionRow = provider
    ? sessionsDb.getSessionByProviderSessionId(provider, sessionId)
    : null;
  if (rowMatchesProvider(providerSessionRow, provider)) {
    return providerSessionRow;
  }

  return null;
}

function normalizeNotificationSession(event) {
  if (!event?.sessionId || !event.provider || event.provider === 'system') {
    return event;
  }

  const row = resolveSessionRow(event.sessionId, event.provider);
  if (!row || row.session_id === event.sessionId) {
    return event;
  }

  return {
    ...event,
    sessionId: row.session_id
  };
}

function resolveSessionName(event) {
  const explicitSessionName = normalizeSessionName(event.meta?.sessionName);
  if (explicitSessionName) {
    return explicitSessionName;
  }

  if (!event.sessionId || !event.provider) {
    return null;
  }

  return normalizeSessionName(sessionsDb.getSessionName(event.sessionId, event.provider));
}

function buildNotificationPayload(event) {
  const normalizedEvent = normalizeNotificationSession(event);
  const CODE_MAP = {
    'permission.required': normalizedEvent.meta?.toolName
      ? `Action Required: Tool "${normalizedEvent.meta.toolName}" needs approval`
      : 'Action Required: A tool needs your approval',
    'run.stopped': normalizedEvent.meta?.stopReason || 'Run Stopped: The run has stopped',
    'run.failed': normalizedEvent.meta?.error ? `Run Failed: ${normalizedEvent.meta.error}` : 'Run Failed: The run encountered an error',
    'live.turn_end': normalizedEvent.meta?.stopReason === 'error'
      ? 'Turn ended with an error in the tmux session'
      : 'Reply ready — the tmux session finished its turn',
    'agent.notification': normalizedEvent.meta?.message ? String(normalizedEvent.meta.message) : 'You have a new notification',
    'push.enabled': 'Push notifications are now enabled!'
  };
  const providerLabel = PROVIDER_LABELS[normalizedEvent.provider] || 'Assistant';
  const sessionName = resolveSessionName(normalizedEvent);
  const message = CODE_MAP[normalizedEvent.code] || 'You have a new notification';

  return {
    title: sessionName || 'ChatMux',
    body: `${providerLabel}: ${message}`,
    data: {
      sessionId: normalizedEvent.sessionId || null,
      code: normalizedEvent.code,
      provider: normalizedEvent.provider || null,
      sessionName,
      tag: `${normalizedEvent.provider || 'assistant'}:${normalizedEvent.sessionId || 'none'}:${normalizedEvent.code}`
    }
  };
}

function sendWebPushPayload(userId, payload) {
  const subscriptions = pushSubscriptionsDb.getSubscriptions(userId);
  if (!subscriptions.length) return Promise.resolve();

  const serializedPayload = JSON.stringify(payload);
  return Promise.allSettled(
    subscriptions.map((sub) =>
      webPush.sendNotification(
        {
          endpoint: sub.endpoint,
          keys: {
            p256dh: sub.keys_p256dh,
            auth: sub.keys_auth
          }
        },
        serializedPayload
      )
    )
  ).then((results) => {
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        const statusCode = result.reason?.statusCode;
        if (statusCode === 410 || statusCode === 404) {
          pushSubscriptionsDb.removeSubscription(subscriptions[index].endpoint);
        }
      }
    });
  });
}

function notifyUserIfEnabled({ userId, event }) {
  if (!userId || !event) {
    return;
  }

  const normalizedEvent = normalizeNotificationSession(event);
  const preferences = notificationPreferencesDb.getPreferences(userId);
  if (!isNotificationEventEnabled(preferences, normalizedEvent)) {
    return;
  }
  if (isDuplicate(normalizedEvent)) {
    return;
  }

  if (!preferences?.channels?.webPush) {
    return;
  }

  const payload = buildNotificationPayload(normalizedEvent);
  void sendWebPushPayload(userId, payload).catch((err) => {
    console.error('Web push send error:', err);
  });
}

function notifyRunStopped({ userId, provider, sessionId = null, stopReason = 'completed', sessionName = null }) {
  notifyUserIfEnabled({
    userId,
    event: createNotificationEvent({
      provider,
      sessionId,
      kind: 'stop',
      code: 'run.stopped',
      meta: { stopReason, sessionName },
      severity: 'info',
      dedupeKey: `${provider}:run:stop:${sessionId || 'none'}:${stopReason}`
    })
  });
}

function notifyRunFailed({ userId, provider, sessionId = null, error, sessionName = null }) {
  const errorMessage = normalizeErrorMessage(error);

  notifyUserIfEnabled({
    userId,
    event: createNotificationEvent({
      provider,
      sessionId,
      kind: 'error',
      code: 'run.failed',
      meta: { error: errorMessage, sessionName },
      severity: 'error',
      dedupeKey: `${provider}:run:error:${sessionId || 'none'}:${errorMessage}`
    })
  });
}

/**
 * Turn completion of a tmux-driven (externally owned) gjc session, detected by
 * the live turn monitor from the transcript's assistant stopReason. Separate
 * kind (`live_stop` → prefs.events.liveStop) from web-run `stop` so the two
 * lanes toggle independently.
 *
 * @param {{ userId: number, sessionId: string | null, tmuxName?: string | null, stopReason?: string }} args
 */
function notifyLiveTurnEnded({ userId, sessionId, tmuxName = null, stopReason = 'stop' }) {
  notifyUserIfEnabled({
    userId,
    event: createNotificationEvent({
      provider: 'gjc',
      sessionId,
      kind: 'live_stop',
      code: 'live.turn_end',
      meta: { sessionName: tmuxName, stopReason },
      severity: stopReason === 'error' ? 'error' : 'info',
      dedupeKey: `gjc:live:turn:${sessionId || 'none'}`
    })
  });
}

export {
  buildNotificationPayload,
  createNotificationEvent,
  notifyUserIfEnabled,
  notifyRunStopped,
  notifyRunFailed,
  notifyLiveTurnEnded
};
