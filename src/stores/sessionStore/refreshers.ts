/**
 * Reconcile refresh for the session store: re-fetches the currently loaded
 * transcript window after streaming/reconnect and drains refreshes queued while
 * a window mutation was in flight. Split from the former `useSessionStore.ts`.
 */

import { authenticatedFetch } from '../../utils/api';
import { sessionRefreshUrl } from '../sessionStoreScope';

import type { SessionStoreInternals } from './internals';
import { dedupeMessagesById, type NormalizedMessage, type SessionSlot } from './messages';
import { pruneRealtimeSupersededByServer, recomputeMergedIfNeeded } from './merge';
import { applyHistoryEpoch } from './realtime';

export function createSessionStoreRefreshers(internals: SessionStoreInternals) {
  const {
    beginRequest,
    notify,
    queuedRefreshesRef,
    refreshFromServerRef,
    slotKeyOf,
    storeRef,
    scopeRef,
    touchSlot,
    trimInactiveSlots,
  } = internals;

  const runQueuedRefresh = (sessionId: string, slotKey: string, slot: SessionSlot) => {
    if (!slot._reconcilePending || slot._pendingRequests !== 0) {
      return;
    }
    const queued = queuedRefreshesRef.current.get(slotKey);
    if (!queued || !refreshFromServerRef.current) {
      return;
    }
    slot._reconcilePending = false;
    void refreshFromServerRef.current(sessionId).then((refreshedSlot) => {
      queued.resolve(refreshedSlot);
      queuedRefreshesRef.current.delete(slotKey);
    });
  };

  const refreshFromServer = async (
    sessionId: string,
    opts: { includeImages?: boolean } = {},
  ) => {
    // Reconcile polling is lower priority than an explicit initial, paginated,
    // or load-all request. Let that window mutation finish instead of
    // invalidating its fetch ticket and making the UI believe an unchanged
    // slot was successfully expanded.
    const slotKey = slotKeyOf(sessionId);
    const pendingSlot = storeRef.current.get(slotKey);
    if (pendingSlot && typeof opts.includeImages === 'boolean') {
      pendingSlot._includeImages = opts.includeImages;
    }
    if (pendingSlot && pendingSlot._pendingRequests > 0) {
      pendingSlot._reconcilePending = true;
      touchSlot(slotKey, pendingSlot);
      const queued = queuedRefreshesRef.current.get(slotKey);
      if (queued) {
        return queued.promise;
      }
      let resolve!: (slot: SessionSlot) => void;
      const promise = new Promise<SessionSlot>((nextResolve) => {
        resolve = nextResolve;
      });
      queuedRefreshesRef.current.set(slotKey, { promise, resolve });
      return promise;
    }

    const slot = beginRequest(slotKey);
    if (typeof opts.includeImages === 'boolean') {
      slot._includeImages = opts.includeImages;
    }
    const fetchTicket = ++slot._fetchSeq;
    if (slot.status === 'loading') {
      slot._loadingTicket = fetchTicket;
    }
    try {
      // Bound the reconcile fetch to the currently-loaded window so a large
      // transcript is not re-pulled in full on every refresh (latest-N + scroll-up
      // lazy-load stays intact). total/hasMore below keep older messages reachable.
      const loadedCount = slot.serverMessages.length + slot.realtimeMessages.length;
      const url = sessionRefreshUrl(scopeRef.current, sessionId, loadedCount, slot._includeImages);
      const response = await authenticatedFetch(url);

      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      const data = body?.data ?? body;

      // Only the latest request may replace this session's loaded window.
      if (fetchTicket !== slot._fetchSeq) {
        return slot;
      }

      const messages: NormalizedMessage[] = data.messages || [];
      applyHistoryEpoch(slot, data);
      slot.serverMessages = dedupeMessagesById(messages);
      slot.total = data.total ?? messages.length;
      slot.hasMore = Boolean(data.hasMore);
      slot.offset = messages.length;
      slot.fetchedAt = Date.now();
      if (slot.status === 'loading' && slot._loadingTicket === fetchTicket) {
        slot.status = 'idle';
      }
      // Only drop realtime rows the server transcript now owns. A blind clear
      // here caused the chat pane to flash "Continue your conversation" after
      // `complete` while JSONL / provider_session_id indexing was still behind.
      slot.realtimeMessages = pruneRealtimeSupersededByServer(
        slot.serverMessages,
        slot.realtimeMessages,
      );
      recomputeMergedIfNeeded(slot);
      notify(slotKey);
      return slot;
    } catch (error) {
      console.error(`[SessionStore] refresh failed for ${sessionId}:`, error);
      if (
        fetchTicket === slot._fetchSeq
        && slot.status === 'loading'
        && slot._loadingTicket === fetchTicket
      ) {
        slot.status = 'idle';
        notify(slotKey);
      }
      return slot;
    } finally {
      slot._pendingRequests -= 1;
      if (slot._loadingTicket === fetchTicket) {
        slot._loadingTicket = null;
      }
      runQueuedRefresh(sessionId, slotKey, slot);
      trimInactiveSlots();
    }
  };

  return { refreshFromServer, runQueuedRefresh };
}
