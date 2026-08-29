/**
 * Host-scoped view over the host-qualified processing map.
 *
 * The store of record is keyed by host-qualified keys so two installations can
 * run the same local session id at once. Chat components, however, only ever ask
 * about the session they are showing, and they ask by its bare local id. This
 * module narrows the qualified map to exactly one host so a bare-id lookup can
 * never read another host's run.
 */

import { useMemo } from 'react';

import type { QualifiedSessionActivityMap, SessionActivity, SessionActivityMap } from '../hooks/useSessionProtection';

export function scopeSessionActivity(
  activities: QualifiedSessionActivityMap,
  hostId: string | null,
): SessionActivityMap {
  const scoped = new Map<string, SessionActivity>();
  for (const activity of activities.values()) {
    if (activity.hostId === hostId) {
      scoped.set(activity.localId, activity);
    }
  }
  return scoped;
}

export function useHostScopedSessionActivity(
  activities: QualifiedSessionActivityMap,
  hostId: string | null,
): SessionActivityMap {
  return useMemo(() => scopeSessionActivity(activities, hostId), [activities, hostId]);
}
