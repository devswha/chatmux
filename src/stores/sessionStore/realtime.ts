/**
 * Realtime ingestion for the session store: history-epoch tracking and the
 * identity-based upsert that keeps one row per live message. Split from the
 * former `useSessionStore.ts` — import from there (the facade), not here.
 */

import {
  EMPTY,
  MAX_REALTIME_MESSAGES,
  type NormalizedMessage,
  type SessionSlot,
} from './messages';

/**
 * Records a provider-native `/clear` boundary. The first observed epoch merely
 * initializes the slot; later changes mean every cached/realtime row belongs
 * to an earlier context and must not survive the server window replacement.
 */
export function applyHistoryEpoch(slot: SessionSlot, data: Record<string, unknown>): boolean {
  if (!Object.prototype.hasOwnProperty.call(data, 'historyEpoch')) {
    return false;
  }

  const nextEpoch = typeof data.historyEpoch === 'string' ? data.historyEpoch : null;
  const changed = slot._historyEpochKnown && slot.historyEpoch !== nextEpoch;
  slot._historyEpochKnown = true;
  slot.historyEpoch = nextEpoch;

  if (changed) {
    slot.realtimeMessages = EMPTY;
    slot.tokenUsage = null;
  }
  return changed;
}

function getRealtimeMessageIdentity(message: NormalizedMessage): string | null {
  if (message.id) {
    return `id:${message.id}`;
  }
  if (typeof message.sequence === 'number' && Number.isFinite(message.sequence)) {
    return `sequence:${message.sessionId}:${message.sequence}`;
  }
  return null;
}

export function upsertRealtimeMessages(
  existing: NormalizedMessage[],
  incoming: NormalizedMessage[],
): NormalizedMessage[] {
  const updated = [...existing];
  const indexes = new Map<string, number>();

  updated.forEach((message, index) => {
    const identity = getRealtimeMessageIdentity(message);
    if (identity) indexes.set(identity, index);
  });

  for (const message of incoming) {
    const identity = getRealtimeMessageIdentity(message);
    const existingIndex = identity ? indexes.get(identity) : undefined;
    if (existingIndex !== undefined) {
      updated[existingIndex] = message;
      continue;
    }
    if (identity) indexes.set(identity, updated.length);
    updated.push(message);
  }

  return updated.length > MAX_REALTIME_MESSAGES
    ? updated.slice(-MAX_REALTIME_MESSAGES)
    : updated;
}
