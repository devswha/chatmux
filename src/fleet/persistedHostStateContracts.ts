export const PERSISTED_HOST_STATE_VERSION = 2;

export const LEGACY_QUEUED_MESSAGE_PREFIX = 'queued_message_';
export const LEGACY_LIVE_SESSION_ORDER_KEY = 'chatmux.liveSessionOrder.v1';
export const QUEUED_DRAFT_PREFIX = 'chatmux.queuedDraft.v2.';
export const LIVE_SESSION_ORDER_KEY = 'chatmux.liveSessionOrder.v2';
export const IDENTITY_MARKER_KEY = 'chatmux.fleetIdentity.v2';

/** Narrow storage port; `localStorage` satisfies it and tests use an in-memory fake. */
export type PersistedStateStorage = {
  keys(): readonly string[];
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

/** Composer draft persisted for a session: text plus the send options it was composed under. */
export type QueuedDraftRecord = {
  readonly content: string;
  readonly options?: Record<string, unknown>;
};

export type PersistedStateMigration = {
  readonly status: 'identity-unknown' | 'migrated' | 'already-migrated' | 'dropped-ambiguous';
  readonly migratedDrafts: number;
  readonly droppedPointers: number;
};

export function browserPersistedStateStorage(): PersistedStateStorage | null {
  if (typeof localStorage === 'undefined') {
    return null;
  }
  return {
    keys: () => Object.keys(localStorage),
    getItem: (key) => localStorage.getItem(key),
    setItem: (key, value) => localStorage.setItem(key, value),
    removeItem: (key) => localStorage.removeItem(key),
  };
}
