import { useCallback, useState } from 'react';

import { type HostQualifiedKey, type SessionTarget, sessionSlotKey } from '../fleet/references';

export interface SessionActivity {
  /** Provider-supplied status line; null renders the default activity label. */
  statusText: string | null;
  canInterrupt: boolean;
  /**
   * When this request was first marked as processing (client clock). Drives
   * the elapsed-time display and the stale `chat_subscribed` idle-ack guard.
   */
  startedAt: number;
  /**
   * Installation owning the run. `null` while the server has not supplied the
   * authoritative local host id yet, which keeps pre-identity runs in their own
   * key namespace instead of guessing a host for them.
   */
  hostId: string | null;
  /** Session id as the owning installation knows it. */
  localId: string;
}

/**
 * A session addressed by its owning host. `hostId: null` means "this browser has
 * no authoritative local host id yet", never "any host".
 */
export type { SessionTarget } from '../fleet/references';

/** Host-qualified store of record: two hosts may hold the same local id. */
export type QualifiedSessionActivityMap = ReadonlyMap<HostQualifiedKey, SessionActivity>;

/**
 * Single-host view keyed by bare local session id, produced by
 * `scopeSessionActivity`. Chat components consume this, never the qualified map.
 */
export type SessionActivityMap = ReadonlyMap<string, SessionActivity>;

export type SessionActivitySnapshot = SessionTarget & {
  statusText?: string | null;
  canInterrupt?: boolean;
  startedAt?: number;
};

export type MarkSessionProcessing = (
  sessionId?: string | null,
  activity?: { statusText?: string | null; canInterrupt?: boolean },
) => void;

export type MarkSessionIdle = (
  sessionId?: string | null,
  opts?: { ifStartedBefore?: number },
) => void;

export type MarkTargetProcessing = (
  target: SessionTarget | null,
  activity?: { statusText?: string | null; canInterrupt?: boolean },
) => void;

export type MarkTargetIdle = (
  target: SessionTarget | null,
  opts?: { ifStartedBefore?: number },
) => void;

export type SyncProcessingSessions = (
  sessions: readonly SessionActivitySnapshot[],
) => void;

const LOCAL_ACTIVITY_GRACE_MS = 10_000;

const sessionActivityMapsMatch = (
  left: QualifiedSessionActivityMap,
  right: QualifiedSessionActivityMap,
): boolean => {
  if (left.size !== right.size) {
    return false;
  }

  for (const [sessionKey, leftActivity] of left) {
    const rightActivity = right.get(sessionKey);
    if (
      !rightActivity
      || leftActivity.statusText !== rightActivity.statusText
      || leftActivity.canInterrupt !== rightActivity.canInterrupt
      || leftActivity.startedAt !== rightActivity.startedAt
    ) {
      return false;
    }
  }

  return true;
};

const targetKey = (target: SessionTarget): HostQualifiedKey =>
  sessionSlotKey(target.hostId, target.localId);

/**
 * Single source of truth for which sessions are actively processing a
 * request. Everything the chat UI shows (activity indicator, abort
 * availability, status text) is derived from this map; terminal events
 * (`complete`, abort, an authoritative idle subscribe ack) delete the entry
 * atomically. Entries are keyed by host-qualified session keys, so the same
 * local id running on two installations stays two independent runs.
 */
export function useSessionProtection() {
  const [processingSessions, setProcessingSessions] = useState<QualifiedSessionActivityMap>(
    new Map<HostQualifiedKey, SessionActivity>(),
  );

  const markProcessing = useCallback<MarkTargetProcessing>((target, activity) => {
    if (!target?.localId) {
      return;
    }

    const sessionKey = targetKey(target);
    setProcessingSessions((prev) => {
      const existing = prev.get(sessionKey);
      const next: SessionActivity = {
        statusText:
          activity?.statusText !== undefined ? activity.statusText : existing?.statusText ?? null,
        canInterrupt: activity?.canInterrupt ?? existing?.canInterrupt ?? true,
        startedAt: existing?.startedAt ?? Date.now(),
        hostId: target.hostId,
        localId: target.localId,
      };

      if (
        existing
        && existing.statusText === next.statusText
        && existing.canInterrupt === next.canInterrupt
      ) {
        return prev;
      }

      const updated = new Map(prev);
      updated.set(sessionKey, next);
      return updated;
    });
  }, []);

  const markIdle = useCallback<MarkTargetIdle>((target, opts) => {
    if (!target?.localId) {
      return;
    }

    const sessionKey = targetKey(target);
    setProcessingSessions((prev) => {
      const existing = prev.get(sessionKey);
      if (!existing) {
        return prev;
      }

      // Guard against stale `chat_subscribed` idle acks: if a new request
      // started after the subscribe was sent, the idle ack describes the
      // older request and must not clear the newer one.
      if (opts?.ifStartedBefore !== undefined && existing.startedAt >= opts.ifStartedBefore) {
        return prev;
      }

      const updated = new Map(prev);
      updated.delete(sessionKey);
      return updated;
    });
  }, []);

  const syncProcessing = useCallback<SyncProcessingSessions>((sessions) => {
    const now = Date.now();

    setProcessingSessions((prev) => {
      const incoming = new Map<HostQualifiedKey, SessionActivitySnapshot>();
      for (const session of sessions) {
        if (!session.localId) {
          continue;
        }
        incoming.set(targetKey(session), session);
      }

      const updated = new Map<HostQualifiedKey, SessionActivity>();

      for (const [sessionKey, snapshot] of incoming) {
        const existing = prev.get(sessionKey);
        const snapshotStartedAt =
          typeof snapshot.startedAt === 'number' && Number.isFinite(snapshot.startedAt) && snapshot.startedAt > 0
            ? snapshot.startedAt
            : undefined;

        updated.set(sessionKey, {
          statusText:
            snapshot.statusText !== undefined ? snapshot.statusText : existing?.statusText ?? null,
          canInterrupt: snapshot.canInterrupt ?? existing?.canInterrupt ?? true,
          startedAt: snapshotStartedAt ?? existing?.startedAt ?? now,
          hostId: snapshot.hostId,
          localId: snapshot.localId,
        });
      }

      for (const [sessionKey, activity] of prev) {
        if (!incoming.has(sessionKey) && now - activity.startedAt < LOCAL_ACTIVITY_GRACE_MS) {
          updated.set(sessionKey, activity);
        }
      }

      return sessionActivityMapsMatch(prev, updated) ? prev : updated;
    });
  }, []);

  return {
    processingSessions,
    markProcessing,
    markIdle,
    syncProcessing,
  };
}
