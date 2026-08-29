import {
  LIVE_SESSION_ORDER_KEY,
  PERSISTED_HOST_STATE_VERSION,
  type PersistedStateStorage,
} from './persistedHostStateContracts';
import { parsePersistedRecord } from './persistedStateParsing';
import { sessionSlotKey } from './references';

const MAX_ORDER_ENTRIES = 200;

function dedupeEntries(entries: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  for (const entry of entries) {
    if (typeof entry !== 'string' || entry.length === 0 || seen.has(entry)) continue;
    seen.add(entry);
    order.push(entry);
    if (order.length === MAX_ORDER_ENTRIES) break;
  }
  return order;
}

export function readPersistedSessionOrder(storage: PersistedStateStorage): string[] {
  const record = parsePersistedRecord(storage.getItem(LIVE_SESSION_ORDER_KEY) ?? '');
  if (record === null || record.version !== PERSISTED_HOST_STATE_VERSION || !Array.isArray(record.entries)) {
    return [];
  }
  return dedupeEntries(record.entries);
}

export function writePersistedSessionOrder(
  storage: PersistedStateStorage,
  entries: readonly string[],
): void {
  storage.setItem(LIVE_SESSION_ORDER_KEY, JSON.stringify({
    version: PERSISTED_HOST_STATE_VERSION,
    entries: dedupeEntries(entries),
  }));
}

/**
 * Order key for a pane row. Deliberately excludes the process generation: a
 * pane keeps its place in the sidebar when its process restarts. `parseLocalId`
 * rejects NUL, so the composed local id can never collide with a real session.
 */
export function paneIdentityOrderKey(
  hostId: string | null,
  tmuxFields: readonly string[],
): string {
  return sessionSlotKey(hostId, `pane\u0000${tmuxFields.join('\u0000')}`);
}
