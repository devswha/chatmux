import { useEffect, useRef } from 'react';

import { clearQueuedDraft, type PersistedStateStorage, readQueuedDraft } from '../fleet/persistedHostState';
import type { HostQualifiedKey } from '../fleet/references';

import type { MarkTargetProcessing, QualifiedSessionActivityMap } from './useSessionProtection';

interface UseQueuedMessageAutoSendArgs {
  processingSessions: QualifiedSessionActivityMap;
  /**
   * The session currently open in the chat view, as a host-qualified key. Its
   * queued draft is owned by the composer (which also handles image attachments
   * and slash commands), so this hook never touches it.
   */
  activeSessionKey: HostQualifiedKey | null;
  /**
   * Sessions currently owned by an external driver (tmux gjc), host-qualified.
   * Auto-sending a queued draft into one would inject a second driver invisibly
   * (리뷰 HIGH) — the draft stays stored until the session is no longer
   * externally owned.
   */
  liveSessionKeys?: ReadonlySet<HostQualifiedKey>;
  /** Authoritative local host id, or null before the server supplies one. */
  localHostId: string | null;
  /** Draft store, or null when this browser has no usable storage. */
  storage: PersistedStateStorage | null;
  ws: WebSocket | null;
  sendMessage: (message: unknown) => void;
  markProcessing: MarkTargetProcessing;
}

/**
 * Dispatches queued messages for sessions the user is NOT currently viewing.
 *
 * The composer persists each queued draft (text + send options snapshotted at
 * queue time) under a host-qualified key. When a session's run leaves the
 * processing map — its previous response completed — this hook sends that
 * session's queued message immediately instead of waiting for the user to
 * open the session again. Removing the storage key before sending is the
 * claim that keeps the composer's own flush from double-sending.
 *
 * Only sessions owned by this installation are dispatched here. The legacy
 * `chat.send` frame carries a bare session id that the receiving server resolves
 * against its own database, so sending a remote host's draft through it would
 * deliver the message to whichever local session happens to share that id. A
 * remote draft therefore stays queued until the host-qualified send path exists.
 */
export function useQueuedMessageAutoSend({
  processingSessions,
  activeSessionKey,
  liveSessionKeys,
  localHostId,
  storage,
  ws,
  sendMessage,
  markProcessing,
}: UseQueuedMessageAutoSendArgs) {
  const prevProcessingRef = useRef<QualifiedSessionActivityMap>(new Map());

  useEffect(() => {
    const prev = prevProcessingRef.current;
    prevProcessingRef.current = processingSessions;
    if (storage === null) {
      return;
    }

    for (const [sessionKey, activity] of prev) {
      if (
        processingSessions.has(sessionKey)
        || sessionKey === activeSessionKey
        || liveSessionKeys?.has(sessionKey)
        || activity.hostId !== localHostId
      ) {
        continue;
      }

      const target = { hostId: activity.hostId, localId: activity.localId };
      const queued = readQueuedDraft(storage, target);
      if (!queued) {
        continue;
      }

      // A closed socket would drop the send silently; keep the draft so the
      // composer (or a later completion) can retry once we're connected.
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        continue;
      }

      clearQueuedDraft(storage, target);
      sendMessage({
        type: 'chat.send',
        sessionId: activity.localId,
        content: queued.content,
        options: { ...(queued.options ?? {}), images: [] },
      });
      markProcessing(target, { statusText: null, canInterrupt: true });
    }
  }, [
    processingSessions,
    activeSessionKey,
    liveSessionKeys,
    localHostId,
    storage,
    ws,
    sendMessage,
    markProcessing,
  ]);
}
