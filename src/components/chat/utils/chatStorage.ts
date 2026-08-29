import { activeSessionHostId, localHostId } from '../../../fleet/hostIdentity';
import {
  clearQueuedDraft,
  LEGACY_QUEUED_MESSAGE_PREFIX,
  type PersistedStateStorage,
  QUEUED_DRAFT_PREFIX,
  readQueuedDraft,
  writeQueuedDraft,
} from '../../../fleet/persistedHostState';
import type { ClaudeSettings } from '../types/types';

export const CLAUDE_SETTINGS_KEY = 'claude-settings';

export const safeLocalStorage = {
  setItem: (key: string, value: string) => {
    try {
      localStorage.setItem(key, value);
    } catch (error: any) {
      if (error?.name === 'QuotaExceededError') {
        console.warn('localStorage quota exceeded, clearing old data');

        const keys = Object.keys(localStorage);
        const draftKeys = keys.filter((k) => k.startsWith('draft_input_')
          || k.startsWith(LEGACY_QUEUED_MESSAGE_PREFIX)
          || k.startsWith(QUEUED_DRAFT_PREFIX));
        draftKeys.forEach((k) => {
          localStorage.removeItem(k);
        });

        try {
          localStorage.setItem(key, value);
        } catch (retryError) {
          console.error('Failed to save to localStorage even after cleanup:', retryError);
        }
      } else {
        console.error('localStorage error:', error);
      }
    }
  },
  getItem: (key: string): string | null => {
    try {
      return localStorage.getItem(key);
    } catch (error) {
      console.error('localStorage getItem error:', error);
      return null;
    }
  },
  removeItem: (key: string) => {
    try {
      localStorage.removeItem(key);
    } catch (error) {
      console.error('localStorage removeItem error:', error);
    }
  },
};

/**
 * Composer options captured when a message is queued, so the message can be
 * sent later with the exact settings (model, permission mode, tools) the
 * session's composer had at queue time — even from outside the composer,
 * e.g. the app-level auto-send that fires while another session is viewed.
 */
export type QueuedSendOptions = Record<string, unknown>;

export type StoredQueuedMessage = {
  content: string;
  options?: QueuedSendOptions;
};

/**
 * Quota-aware storage port for host-qualified draft records. Draft reads and
 * writes must survive a full or unavailable `localStorage`, which is exactly what
 * `safeLocalStorage` already handles for every other composer key.
 */
const draftStorage: PersistedStateStorage = {
  keys: () => {
    try {
      return Object.keys(localStorage);
    } catch {
      return [];
    }
  },
  getItem: (key) => safeLocalStorage.getItem(key),
  setItem: (key, value) => safeLocalStorage.setItem(key, value),
  removeItem: (key) => safeLocalStorage.removeItem(key),
};

export const queuedMessageKey = (sessionId: string) => `${LEGACY_QUEUED_MESSAGE_PREFIX}${sessionId}`;

/**
 * Host the composer's bare session id belongs to: the viewed session's host, or
 * the local installation when no session route host applies. `null` means the
 * server has not supplied an authoritative identity yet, and the legacy bare key
 * layout is kept untouched until it does.
 */
function composerTarget(sessionId: string) {
  return { hostId: activeSessionHostId() ?? localHostId(), localId: sessionId };
}

/**
 * Reads a session's queued draft, host-qualified once the identity is known and
 * from the legacy bare key before that. Understands the versioned record, the
 * `{ content, options }` object, and the oldest raw-text format.
 */
export function readQueuedMessage(sessionId: string): StoredQueuedMessage | null {
  return readQueuedDraft(draftStorage, composerTarget(sessionId));
}

export function writeQueuedMessage(sessionId: string, message: StoredQueuedMessage): void {
  writeQueuedDraft(draftStorage, composerTarget(sessionId), message);
}

export function clearQueuedMessage(sessionId: string): void {
  clearQueuedDraft(draftStorage, composerTarget(sessionId));
}

export function getClaudeSettings(): ClaudeSettings {
  const raw = safeLocalStorage.getItem(CLAUDE_SETTINGS_KEY);
  if (!raw) {
    return {
      allowedTools: [],
      disallowedTools: [],
      skipPermissions: false,
      projectSortOrder: 'name',
    };
  }

  try {
    const parsed = JSON.parse(raw);
    return {
      ...parsed,
      allowedTools: Array.isArray(parsed.allowedTools) ? parsed.allowedTools : [],
      disallowedTools: Array.isArray(parsed.disallowedTools) ? parsed.disallowedTools : [],
      skipPermissions: Boolean(parsed.skipPermissions),
      projectSortOrder: parsed.projectSortOrder || 'name',
    };
  } catch {
    return {
      allowedTools: [],
      disallowedTools: [],
      skipPermissions: false,
      projectSortOrder: 'name',
    };
  }
}
