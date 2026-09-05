import { activeSessionHostId, localHostId } from '../../../fleet/hostIdentity';
import { projectSlotKey } from '../../../fleet/references';
import {
  clearQueuedDraft,
  LEGACY_QUEUED_MESSAGE_PREFIX,
  type PersistedStateStorage,
  readQueuedDraft,
  writeQueuedDraft,
} from '../../../fleet/persistedHostState';
import type { ClaudeSettings } from '../types/types';

export const CLAUDE_SETTINGS_KEY = 'claude-settings';
const PROJECT_DRAFT_PREFIX = 'chatmux.projectDraft.v1:';

export function draftInputKey(projectId: string, hostId: string | null): string {
  return hostId === null
    ? `draft_input_${projectId}`
    : `${PROJECT_DRAFT_PREFIX}${projectSlotKey(hostId, projectId)}`;
}

export function readDraftInput(projectId: string, hostId: string | null): string {
  const key = draftInputKey(projectId, hostId);
  const saved = safeLocalStorage.getItem(key);
  if (saved !== null) return saved;
  // Bare pre-fleet drafts can only belong to the authoritative local host.
  // A peer with the same project ID must never inherit them.
  if (hostId !== null && hostId === localHostId()) {
    const legacyKey = draftInputKey(projectId, null);
    const legacy = safeLocalStorage.getItem(legacyKey);
    if (legacy !== null) {
      safeLocalStorage.setItem(key, legacy);
      if (safeLocalStorage.getItem(key) === legacy) safeLocalStorage.removeItem(legacyKey);
      return legacy;
    }
  }
  return '';
}

export function clearDraftInput(projectId: string, hostId: string | null): void {
  const key = draftInputKey(projectId, hostId);
  safeLocalStorage.setItem(key, '');
  if (safeLocalStorage.getItem(key) === '') return;
  // Quota can prevent even the empty migration marker. Removing this project's
  // own records needs no space; a peer clear must leave local legacy work alone.
  if (hostId !== null && hostId === localHostId()) {
    safeLocalStorage.removeItem(draftInputKey(projectId, null));
  }
  safeLocalStorage.removeItem(key);
}

export const safeLocalStorage = {
  setItem: (key: string, value: string) => {
    try {
      localStorage.setItem(key, value);
    } catch (error: any) {
      if (error?.name === 'QuotaExceededError') {
        // Drafts are unsent user work, including queues owned by other hosts.
        // Keep existing records intact and let the active draft remain in memory.
        console.warn('localStorage quota exceeded; draft storage was left intact');
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
