import type { ExternalCliSession, ExternalSessionActivity } from '../hooks/useExternalCliSessions';

export type SessionAttention = 'input' | 'failure' | 'connection' | null;
export type SessionAttentionFilter = 'all' | Exclude<SessionAttention, null>;

/** Display classification only. Never grants permission to send, approve or attach. */
export function sessionAttention({
  activity,
  presence,
  authority,
  connectionIssue,
}: {
  activity?: ExternalSessionActivity;
  presence?: ExternalCliSession['presence'];
  authority?: ExternalCliSession['authority'];
  connectionIssue?: ExternalCliSession['connectionIssue'];
}): SessionAttention {
  if (presence === 'stale' || authority === 'none') return null;
  if (connectionIssue) return 'connection';
  if (activity === 'asking_user') return 'input';
  if (activity === 'error') return 'failure';
  return null;
}

/** Find the next eligible row in sidebar order, wrapping once, even if the
 * current row stopped matching. Keys are the existing host-qualified row IDs. */
export function nextAttentionRow<T>(
  rows: readonly T[],
  currentId: string | null,
  getId: (row: T) => string,
  matches: (row: T) => boolean,
): T | null {
  const start = rows.findIndex((row) => getId(row) === currentId);
  for (let step = 1; step <= rows.length; step += 1) {
    const row = rows[(start + step) % rows.length]!;
    if (matches(row)) return row;
  }
  return null;
}
