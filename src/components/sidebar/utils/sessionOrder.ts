import type { TmuxPaneIdentity } from '../../../../shared/tmux';

export const LIVE_SESSION_ORDER_STORAGE_KEY = 'chatmux.liveSessionOrder.v1';

const MAX_STORED_SESSION_IDS = 200;

export function createSessionOrderId(
  sessionId: string,
  tmux?: TmuxPaneIdentity,
): string {
  return tmux
    ? `tmux:${tmux.socketPath}\u0000${tmux.sessionId}\u0000${tmux.windowId}\u0000${tmux.paneId}`
    : `session:${sessionId}`;
}

export function parseStoredSessionOrder(value: string | null): string[] {
  if (!value) return [];

  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];

    const seen = new Set<string>();
    const order: string[] = [];
    for (const entry of parsed) {
      if (typeof entry !== 'string' || entry.length === 0 || seen.has(entry)) continue;
      seen.add(entry);
      order.push(entry);
      if (order.length === MAX_STORED_SESSION_IDS) break;
    }
    return order;
  } catch {
    return [];
  }
}

export function readStoredSessionOrder(): string[] {
  try {
    if (typeof localStorage === 'undefined') return [];
    return parseStoredSessionOrder(localStorage.getItem(LIVE_SESSION_ORDER_STORAGE_KEY));
  } catch {
    return [];
  }
}

export function persistSessionOrder(order: readonly string[]): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(
      LIVE_SESSION_ORDER_STORAGE_KEY,
      JSON.stringify(order.slice(0, MAX_STORED_SESSION_IDS)),
    );
  } catch {
    // Reordering still works for this page when storage is unavailable.
  }
}

export function applySessionOrder<T>(
  rows: readonly T[],
  order: readonly string[],
  getId: (row: T) => string,
): T[] {
  if (order.length === 0) return [...rows];

  const rowsById = new Map(rows.map((row) => [getId(row), row]));
  const orderedRows: T[] = [];

  for (const id of order) {
    const row = rowsById.get(id);
    if (!row) continue;
    orderedRows.push(row);
    rowsById.delete(id);
  }

  orderedRows.push(...rowsById.values());
  return orderedRows;
}

export function migrateSessionOrderAliases(
  order: readonly string[],
  aliases: ReadonlyMap<string, string>,
): string[] {
  const migrated: string[] = [];
  const seen = new Set<string>();

  for (const id of order) {
    const canonicalId = aliases.get(id) ?? id;
    if (seen.has(canonicalId)) continue;
    seen.add(canonicalId);
    migrated.push(canonicalId);
  }

  return migrated;
}
export function mergeVisibleSessionOrder(
  previousOrder: readonly string[],
  visibleOrder: readonly string[],
): string[] {
  const pendingVisible = [...new Set(visibleOrder)];
  const visibleIds = new Set(pendingVisible);
  const merged: string[] = [];
  const added = new Set<string>();
  let visibleIndex = 0;

  for (const previousId of previousOrder) {
    const nextId = visibleIds.has(previousId)
      ? pendingVisible[visibleIndex++]
      : previousId;
    if (!nextId || added.has(nextId)) continue;
    merged.push(nextId);
    added.add(nextId);
  }

  for (; visibleIndex < pendingVisible.length; visibleIndex += 1) {
    const nextId = pendingVisible[visibleIndex];
    if (added.has(nextId)) continue;
    merged.push(nextId);
    added.add(nextId);
  }

  const hiddenBudget = Math.max(0, MAX_STORED_SESSION_IDS - visibleIds.size);
  let hiddenCount = 0;
  return merged.filter((id) => {
    if (visibleIds.has(id)) return true;
    hiddenCount += 1;
    return hiddenCount <= hiddenBudget;
  }).slice(0, MAX_STORED_SESSION_IDS);
}

export function moveSession(
  visibleOrder: readonly string[],
  activeId: string,
  overId: string,
): string[] {
  const from = visibleOrder.indexOf(activeId);
  const to = visibleOrder.indexOf(overId);
  if (from < 0 || to < 0 || from === to) return [...visibleOrder];

  const next = [...visibleOrder];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}
