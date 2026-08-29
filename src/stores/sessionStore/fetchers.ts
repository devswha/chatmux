/**
 * Server fetches for the session store: initial/paginated transcript loads with
 * per-slot fetch tickets so only the latest request may replace a loaded window.
 * Split from the former `useSessionStore.ts` — import the store from there.
 */

import { authenticatedFetch } from '../../utils/api';
import { sessionMessagesUrl } from '../sessionStoreScope';

import type { SessionStoreInternals } from './internals';
import {
  createEmptySlot,
  dedupeMessagesById,
  EMPTY,
  type NormalizedMessage,
} from './messages';
import { recomputeMergedIfNeeded } from './merge';
import { applyHistoryEpoch } from './realtime';

export function createSessionStoreFetchers(internals: SessionStoreInternals) {
  const {
    beginRequest,
    notify,
    refreshFromServerRef,
    runQueuedRefresh,
    slotKeyOf,
    storeRef,
    scopeRef,
    touchSlot,
    trimInactiveSlots,
  } = internals;

  const fetchFromServer = async (
    sessionId: string,
    opts: {
      limit?: number | null;
      offset?: number;
      includeImages?: boolean;
    } = {},
  ) => {
    const slotKey = slotKeyOf(sessionId);
    const slot = beginRequest(slotKey);
    if (typeof opts.includeImages === 'boolean') {
      slot._includeImages = opts.includeImages;
    }
    const fetchTicket = ++slot._fetchSeq;
    if (slot.status !== 'streaming') {
      slot._loadingTicket = fetchTicket;
      slot.status = 'loading';
    }
    notify(slotKey);

    try {
      const params = new URLSearchParams();
      if (opts.limit !== null && opts.limit !== undefined) {
        params.append('limit', String(opts.limit));
        params.append('offset', String(opts.offset ?? 0));
      }
      if (!slot._includeImages) params.set('includeImages', 'false');

      const url = sessionMessagesUrl(scopeRef.current, sessionId, params.toString());
      const response = await authenticatedFetch(url);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const body = await response.json();
      const data = body?.data ?? body;
      const messages: NormalizedMessage[] = data.messages || [];

      // Only the latest request may replace this session's loaded window.
      if (fetchTicket !== slot._fetchSeq) {
        return slot;
      }

      applyHistoryEpoch(slot, data);
      slot.serverMessages = dedupeMessagesById(messages);
      slot.total = data.total ?? messages.length;
      slot.hasMore = Boolean(data.hasMore);
      slot.offset = (opts.offset ?? 0) + messages.length;
      slot.fetchedAt = Date.now();
      if (slot.status === 'loading' && slot._loadingTicket === fetchTicket) {
        slot.status = 'idle';
      }
      recomputeMergedIfNeeded(slot);
      if (data.tokenUsage) {
        slot.tokenUsage = data.tokenUsage;
      }

      notify(slotKey);
      return slot;
    } catch (error) {
      console.error(`[SessionStore] fetch failed for ${sessionId}:`, error);
      // Don't clobber a newer fetch's result with a stale failure.
      if (
        fetchTicket === slot._fetchSeq
        && slot.status === 'loading'
        && slot._loadingTicket === fetchTicket
      ) {
        slot.status = 'error';
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

  const fetchMore = async (
    sessionId: string,
    opts: {
      limit?: number;
      includeImages?: boolean;
    } = {},
  ) => {
    const store = storeRef.current;
    const slotKey = slotKeyOf(sessionId);
    const slot = store.get(slotKey) ?? createEmptySlot();
    if (typeof opts.includeImages === 'boolean') {
      slot._includeImages = opts.includeImages;
    }
    if (!slot.hasMore || slot._fetchMoreTicket !== null) {
      touchSlot(slotKey, slot);
      return slot;
    }

    const expectedOffset = slot.offset;
    const fetchTicket = ++slot._fetchSeq;
    slot._fetchMoreTicket = fetchTicket;
    slot._pendingRequests += 1;
    touchSlot(slotKey, slot);
    if (slot.status === 'loading') {
      slot._loadingTicket = fetchTicket;
    }
    const params = new URLSearchParams();
    const limit = opts.limit ?? 20;
    params.append('limit', String(limit));
    params.append('offset', String(expectedOffset));
    if (!slot._includeImages) params.set('includeImages', 'false');

    const url = sessionMessagesUrl(scopeRef.current, sessionId, params.toString());

    try {
      const response = await authenticatedFetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      const data = body?.data ?? body;
      const olderMessages: NormalizedMessage[] = data.messages || [];

      // A different request or loaded-window replacement invalidated this
      // cursor. Never prepend a page fetched for another offset.
      if (
        fetchTicket !== slot._fetchSeq
        || slot._fetchMoreTicket !== fetchTicket
        || slot.offset !== expectedOffset
      ) {
        return slot;
      }

      if (applyHistoryEpoch(slot, data)) {
        // This page used an offset from the preceding context and cannot be
        // merged into the new one. Clear it immediately and queue a fresh
        // offset-zero reconcile after the in-flight page releases the slot.
        slot.serverMessages = EMPTY;
        slot.total = data.total ?? 0;
        slot.hasMore = false;
        slot.offset = 0;
        recomputeMergedIfNeeded(slot);
        notify(slotKey);
        if (refreshFromServerRef.current) {
          void refreshFromServerRef.current(sessionId);
        }
        return slot;
      }

      slot.serverMessages = dedupeMessagesById([
        ...olderMessages,
        ...slot.serverMessages,
      ]);
      slot.hasMore = Boolean(data.hasMore);
      slot.offset = expectedOffset + olderMessages.length;
      if (slot.status === 'loading' && slot._loadingTicket === fetchTicket) {
        slot.status = 'idle';
      }
      recomputeMergedIfNeeded(slot);
      notify(slotKey);
      return slot;
    } catch (error) {
      console.error(`[SessionStore] fetchMore failed for ${sessionId}:`, error);
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
      if (slot._fetchMoreTicket === fetchTicket) {
        slot._fetchMoreTicket = null;
      }
      if (slot._loadingTicket === fetchTicket) {
        slot._loadingTicket = null;
      }
      runQueuedRefresh(sessionId, slotKey, slot);
      trimInactiveSlots();
    }
  };

  return { fetchFromServer, fetchMore };
}
