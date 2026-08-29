/**
 * App-shell wiring for the background queued-draft auto-send.
 *
 * Queued messages for sessions that finish while another session (or none) is
 * being viewed are sent from here; the viewed session's composer handles its
 * own queue. The draft store is the browser's host-qualified persisted state;
 * tmux-owned sessions are keyed with the local host and never receive an
 * invisible background send. Split from the former `AppContent.tsx`.
 */

import { useMemo } from 'react';

import { browserPersistedStateStorage } from '../../../fleet/persistedHostState';
import { sessionSlotKey } from '../../../fleet/references';
import type { MarkTargetProcessing, QualifiedSessionActivityMap } from '../../../hooks/useSessionProtection';
import { useQueuedMessageAutoSend } from '../../../hooks/useQueuedMessageAutoSend';

export type QueuedDraftAutoSendWiring = {
  qualifiedProcessingSessions: QualifiedSessionActivityMap;
  activeSessionKey: string | null;
  liveSessionIds: ReadonlySet<string>;
  localHostId: string | null;
  ws: WebSocket | null;
  sendMessage: (message: unknown) => void;
  markProcessing: MarkTargetProcessing;
};

export function useQueuedDraftAutoSend({
  qualifiedProcessingSessions,
  activeSessionKey,
  liveSessionIds,
  localHostId,
  ws,
  sendMessage,
  markProcessing,
}: QueuedDraftAutoSendWiring): void {
  const draftStorage = useMemo(() => browserPersistedStateStorage(), []);
  const liveSessionKeys = useMemo(
    () => new Set([...liveSessionIds].map((id) => sessionSlotKey(localHostId, id))),
    [liveSessionIds, localHostId],
  );
  useQueuedMessageAutoSend({
    processingSessions: qualifiedProcessingSessions,
    activeSessionKey,
    liveSessionKeys,
    localHostId,
    storage: draftStorage,
    ws,
    sendMessage,
    markProcessing,
  });
}
