import webPush from 'web-push';

import {
  completionAppAlias,
  completionAppIdentityKey,
  completionNotificationOutboxDb,
  notificationPreferencesDb,
  pushSubscriptionsDb,
  sessionsDb,
} from '@/modules/database/index.js';

import { wakeCompletionOutboxDispatcher } from './completion-outbox-dispatcher.service.js';

const KIND_TO_PREF_KEY = {
  action_required: 'actionRequired',
  stop: 'stop',
  // tmux 라이브(외부 구동) coding-agent 세션의 턴 완료 — 웹 구동 완료(stop)와 분리
  // 토글: tmux 옆에서 작업 중일 땐 이것만 끌 수 있어야 한다.
  live_stop: 'liveStop',
  error: 'error'
};

const PROVIDER_LABELS = {
  claude: 'Claude',
  cursor: 'Cursor',
  codex: 'Codex',
  opencode: 'OpenCode',
  omp: 'Oh My Pi',
  gjc: 'GJC',
  system: 'System'
};

const recentEventKeys = new Map();
const DEDUPE_WINDOW_MS = 20000;
const seenInputOccurrences = new Set();

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

function hasDuplicate(event) {
  if (event.code === 'input.required') {
    return Boolean(event.inputOccurrenceKey) && seenInputOccurrences.has(event.inputOccurrenceKey);
  }
  cleanupOldEventKeys();
  const key = event.dedupeKey || `${event.provider}:${event.kind || 'info'}:${event.code || 'generic'}:${event.sessionId || 'none'}`;
  return recentEventKeys.has(key);
}

function rememberDuplicate(event) {
  if (event.code === 'input.required') {
    if (event.inputOccurrenceKey) seenInputOccurrences.add(event.inputOccurrenceKey);
    return;
  }
  const key = event.dedupeKey || `${event.provider}:${event.kind || 'info'}:${event.code || 'generic'}:${event.sessionId || 'none'}`;
  recentEventKeys.set(key, Date.now());
}

function isDuplicate(event) {
  if (hasDuplicate(event)) return true;
  rememberDuplicate(event);
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
  requiresUserAction = false,
  inputOccurrenceKey = null,
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
    inputOccurrenceKey,
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
    'input.required': 'Input required — the tmux session is waiting for you',
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
function buildCompletionPayload({ provider, sessionId, sessionName = null }) {
  const title = normalizeSessionName(sessionName) || 'ChatMux';
  const providerLabel = PROVIDER_LABELS[provider] || 'Assistant';
  return Object.freeze({
    title,
    body: `${providerLabel}: Reply ready`,
    navigation: Object.freeze({
      href: `/session/${encodeURIComponent(sessionId)}`,
      title,
    }),
  });
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
          pushSubscriptionsDb.removeSubscriptionForUser(userId, subscriptions[index].endpoint);
        } else {
          console.error('Web push send error:', result.reason);
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

/**
 * Records, but never directly sends, a durable reply-ready completion decision.
 * Callers must provide the producer's stable occurrence key; this API never
 * derives one from mutable session state.
 *
 * @param {{ userId: number, target: { provider: string, sessionId: string }, event: { code: 'reply_ready', occurrenceKey: string, preferenceClass: 'stop' | 'liveStop', sessionName?: string | null, stopReason?: 'completed' } }} args
 * @returns {number[]} immutable outbox decision ids
 */
function validateCompletionDecision({ userId, target, event }) {
  if (!Number.isInteger(userId) || userId < 1
    || !target || typeof target.provider !== 'string' || !target.provider
    || typeof target.sessionId !== 'string' || !target.sessionId
    || !event || event.code !== 'reply_ready'
    || (event.preferenceClass !== 'stop' && event.preferenceClass !== 'liveStop')
    || typeof event.occurrenceKey !== 'string' || !event.occurrenceKey.trim()
    || (event.stopReason !== undefined && event.stopReason !== 'completed')) {
    throw new TypeError('completion decision requires an owner, preference class, reply_ready, a normal completion, and a stable occurrence key');
  }
}

function createCompletionDecision({ userId, target, event }) {
  validateCompletionDecision({ userId, target, event });

  const normalizedTarget = normalizeNotificationSession({
    provider: target.provider,
    sessionId: target.sessionId,
  });
  const identity = { provider: target.provider, sessionId: normalizedTarget.sessionId };

  const decisions = completionNotificationOutboxDb.createApplicationDecision({
    userId,
    preferenceClass: event.preferenceClass,
    targetIdentityKey: completionAppIdentityKey(identity),
    provider: target.provider,
    sessionId: normalizedTarget.sessionId,
    eventOccurrenceKey: event.occurrenceKey,
    eventCode: 'reply_ready',
    targetAliasSnapshot: completionAppAlias(identity),
    payload: buildCompletionPayload({
      provider: target.provider,
      sessionId: normalizedTarget.sessionId,
      sessionName: event.sessionName,
    }),
    now: Date.now(),
  });

  // Wake only after the immutable decision commits; durable uniqueness handles replay.
  if (decisions.length > 0) {
    wakeCompletionOutboxDispatcher();
  }
  return decisions;
}

function notifyRunStopped({
  userId,
  provider,
  sessionId = null,
  stopReason = 'completed',
  sessionName = null,
  completionKey = null,
}) {
  if (stopReason !== 'completed') return;
  createCompletionDecision({
    userId,
    target: { provider, sessionId },
    event: {
      code: 'reply_ready',
      preferenceClass: 'stop',
      occurrenceKey: completionKey,
      sessionName,
      stopReason,
    },
  });
}

/**
 * @param {{ userId: number, provider: string, sessionId?: string | null, error: unknown, sessionName?: string | null }} args
 */
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
 * A tmux-driven agent has stopped running and is waiting for a choice,
 * approval, or direct answer. Per-session watch policy is checked by the
 * producer because external generations and app sessions use different
 * durable target identities.
 *
 * @param {{ userId: number, provider: string, sessionId?: string | null, sessionName?: string | null, occurrenceKey?: string | null }} args
 */
function notifyInputRequired({
  userId,
  provider,
  sessionId = null,
  sessionName = null,
  occurrenceKey = null,
}) {
  notifyUserIfEnabled({
    userId,
    event: createNotificationEvent({
      provider,
      sessionId,
      kind: 'action_required',
      code: 'input.required',
      meta: { sessionName },
      severity: 'warning',
      requiresUserAction: true,
      inputOccurrenceKey: occurrenceKey,
    }),
  });
}

/**
 * Turn completion of a tmux-driven session. The monitor must provide its
 * durable generation occurrence key; no session-based fallback is permitted.
 *
 * @param {{ userId: number, provider?: 'gjc', sessionId: string | null, tmuxName?: string | null, stopReason?: string, completionKey?: string | null }} args
 */
function notifyLiveTurnEnded({
  userId,
  provider = 'gjc',
  sessionId,
  tmuxName = null,
  stopReason = 'completed',
  completionKey = null
}) {
  if (stopReason !== 'completed') return;
  const decision = {
    userId,
    target: { provider, sessionId },
    event: {
      code: 'reply_ready',
      preferenceClass: 'liveStop',
      occurrenceKey: completionKey,
      sessionName: tmuxName,
      stopReason,
    },
  };
  if (provider !== 'gjc') {
    throw new RangeError('live turn completion decisions are only supported for GJC');
  }
  createCompletionDecision(decision);
}

export {
  buildCompletionPayload,
  buildNotificationPayload,
  createNotificationEvent,
  notifyUserIfEnabled,
  notifyRunStopped,
  notifyRunFailed,
  notifyInputRequired,
  notifyLiveTurnEnded,
  createCompletionDecision,
};
