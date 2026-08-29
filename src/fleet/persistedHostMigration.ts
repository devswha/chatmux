import {
  IDENTITY_MARKER_KEY,
  LEGACY_LIVE_SESSION_ORDER_KEY,
  LEGACY_QUEUED_MESSAGE_PREFIX,
  type PersistedStateMigration,
  type PersistedStateStorage,
} from './persistedHostStateContracts';
import { parsePersistedArray } from './persistedStateParsing';
import { parseQueuedDraft, writeQueuedDraft } from './persistedQueuedDraft';
import {
  paneIdentityOrderKey,
  readPersistedSessionOrder,
  writePersistedSessionOrder,
} from './persistedSessionOrder';
import { parseLocalId, sessionSlotKey } from './references';

function legacyDraftKeys(storage: PersistedStateStorage): string[] {
  return storage.keys().filter((key) => key.startsWith(LEGACY_QUEUED_MESSAGE_PREFIX));
}

function migrateDrafts(storage: PersistedStateStorage, hostId: string): PersistedStateMigration {
  let migratedDrafts = 0;
  let droppedPointers = 0;

  for (const key of legacyDraftKeys(storage)) {
    const localId = parseLocalId(key.slice(LEGACY_QUEUED_MESSAGE_PREFIX.length));
    const draft = parseQueuedDraft(storage.getItem(key));
    storage.removeItem(key);
    if (localId === null || draft === null) {
      droppedPointers += 1;
      continue;
    }
    writeQueuedDraft(storage, { hostId, localId }, draft);
    migratedDrafts += 1;
  }

  return { status: 'migrated', migratedDrafts, droppedPointers };
}

/**
 * Rewrites the legacy sidebar order. `session:<id>` rows become host-qualified
 * session keys; `tmux:<socket>\0<session>\0<window>\0<pane>` rows become
 * host-qualified pane-identity keys. Anything else is a pointer we cannot
 * attribute, so it is dropped without touching the rest of the order.
 */
function migrateSessionOrder(storage: PersistedStateStorage, hostId: string): number {
  const raw = storage.getItem(LEGACY_LIVE_SESSION_ORDER_KEY);
  if (raw === null) {
    return 0;
  }
  storage.removeItem(LEGACY_LIVE_SESSION_ORDER_KEY);

  const parsed = parsePersistedArray(raw);
  if (parsed === null) {
    return 1;
  }

  let dropped = 0;
  const migrated: string[] = [];
  for (const entry of parsed) {
    const rewritten = migrateOrderEntry(entry, hostId);
    if (rewritten === null) {
      dropped += 1;
      continue;
    }
    migrated.push(rewritten);
  }

  if (migrated.length > 0) {
    writePersistedSessionOrder(storage, [...readPersistedSessionOrder(storage), ...migrated]);
  }
  return dropped;
}

function migrateOrderEntry(entry: unknown, hostId: string): string | null {
  if (typeof entry !== 'string') {
    return null;
  }
  if (entry.startsWith('session:')) {
    const localId = parseLocalId(entry.slice('session:'.length));
    return localId === null ? null : sessionSlotKey(hostId, localId);
  }
  if (entry.startsWith('tmux:')) {
    const parts = entry.slice('tmux:'.length).split('\u0000');
    return parts.length === 4 && parts.every((part) => part.length > 0)
      ? paneIdentityOrderKey(hostId, parts)
      : null;
  }
  return null;
}

export function migrateLegacyPersistedState(
  storage: PersistedStateStorage,
  localHostId: string | null,
): PersistedStateMigration {
  if (localHostId === null) {
    return { status: 'identity-unknown', migratedDrafts: 0, droppedPointers: 0 };
  }

  const marker = storage.getItem(IDENTITY_MARKER_KEY);
  if (marker === localHostId) {
    return { status: 'already-migrated', migratedDrafts: 0, droppedPointers: 0 };
  }

  if (marker !== null) {
    // The authoritative identity changed under an already-migrated browser
    // profile. Bare legacy pointers can no longer be attributed to either host,
    // so they are dropped; host-qualified state stays exactly where it is.
    let droppedPointers = 0;
    for (const key of legacyDraftKeys(storage)) {
      storage.removeItem(key);
      droppedPointers += 1;
    }
    if (storage.getItem(LEGACY_LIVE_SESSION_ORDER_KEY) !== null) {
      storage.removeItem(LEGACY_LIVE_SESSION_ORDER_KEY);
      droppedPointers += 1;
    }
    storage.setItem(IDENTITY_MARKER_KEY, localHostId);
    return { status: 'dropped-ambiguous', migratedDrafts: 0, droppedPointers };
  }

  const drafts = migrateDrafts(storage, localHostId);
  const droppedOrderPointers = migrateSessionOrder(storage, localHostId);
  storage.setItem(IDENTITY_MARKER_KEY, localHostId);
  return {
    status: 'migrated',
    migratedDrafts: drafts.migratedDrafts,
    droppedPointers: drafts.droppedPointers + droppedOrderPointers,
  };
}
