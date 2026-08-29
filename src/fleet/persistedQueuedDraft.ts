import {
  LEGACY_QUEUED_MESSAGE_PREFIX,
  PERSISTED_HOST_STATE_VERSION,
  QUEUED_DRAFT_PREFIX,
  type PersistedStateStorage,
  type QueuedDraftRecord,
} from './persistedHostStateContracts';
import { parsePersistedObject, parsePersistedRecord } from './persistedStateParsing';
import {
  referenceKey,
  type SessionTarget,
  sessionRef,
} from './references';

/**
 * Storage key for a session's queued draft. A session whose host is not known yet
 * keeps the legacy bare-id key, so pre-identity behaviour is byte-identical to
 * what shipped before host qualification.
 */
export function queuedDraftKey(target: SessionTarget): string {
  return target.hostId === null
    ? `${LEGACY_QUEUED_MESSAGE_PREFIX}${target.localId}`
    : `${QUEUED_DRAFT_PREFIX}${referenceKey(sessionRef(target.hostId, target.localId))}`;
}

/**
 * Reads a draft payload. Understands the versioned object, the pre-fleet
 * `{ content, options }` object, and the oldest raw-text format.
 */
export function parseQueuedDraft(raw: string | null): QueuedDraftRecord | null {
  if (raw === null) {
    return null;
  }

  const record = parsePersistedRecord(raw);
  if (record === null) {
    return raw.trim() ? { content: raw } : null;
  }

  const content = typeof record.content === 'string' ? record.content : '';
  if (!content.trim()) {
    return null;
  }

  const options = parsePersistedObject(record.options);
  return options === null ? { content } : { content, options };
}

export function readQueuedDraft(
  storage: PersistedStateStorage,
  target: SessionTarget,
): QueuedDraftRecord | null {
  return parseQueuedDraft(storage.getItem(queuedDraftKey(target)));
}

export function writeQueuedDraft(
  storage: PersistedStateStorage,
  target: SessionTarget,
  draft: QueuedDraftRecord,
): void {
  storage.setItem(queuedDraftKey(target), JSON.stringify({
    version: PERSISTED_HOST_STATE_VERSION,
    hostId: target.hostId,
    localId: target.localId,
    content: draft.content,
    ...(draft.options === undefined ? {} : { options: draft.options }),
  }));
}

export function clearQueuedDraft(
  storage: PersistedStateStorage,
  target: SessionTarget,
): void {
  storage.removeItem(queuedDraftKey(target));
}
