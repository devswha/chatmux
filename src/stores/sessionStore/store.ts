/**
 * Session-keyed message store.
 *
 * Holds per-session state in a Map keyed by the host-qualified session key.
 * Session switch = change the active-slot pointer. No clearing; old data stays.
 * No localStorage for messages. Backend JSONL is the source of truth.
 *
 * Split into cohesive modules under `sessionStore/`; this file composes them
 * and owns slot lifecycle. Import the public API from `../useSessionStore`.
 */

import { useCallback, useMemo, useRef, useState } from 'react';

import {
  LOCAL_SESSION_STORE_SCOPE,
  type SessionStoreScope,
  rekeyUnknownHostSlots,
  sessionStoreSlotKey,
} from '../sessionStoreScope';

import { createSessionStoreFetchers } from './fetchers';
import { createSessionStoreRealtimeOps } from './realtimeOps';
import { createSessionStoreRefreshers } from './refreshers';
import type { SessionStoreInternals } from './internals';
import {
  createEmptySlot,
  EMPTY,
  MAX_SESSION_SLOTS,
  STALE_THRESHOLD_MS,
  type NormalizedMessage,
  type SessionSlot,
  type SessionStatus,
} from './messages';

export function useSessionStore(scope: SessionStoreScope = LOCAL_SESSION_STORE_SCOPE) {
  const storeRef = useRef(new Map<string, SessionSlot>());
  const scopeRef = useRef(scope);
  const activeSlotKeyRef = useRef<string | null>(null);
  // The active session is remembered by its bare local id as well as by its
  // host-qualified key: the same local id can be opened on another host, and then
  // the active slot must move to that host's slot. Keeping only the key would
  // leave this store notifying and protecting the previous host's slot.
  const activeSessionIdRef = useRef<string | null>(null);
  // The authoritative local host id can land after a local session has already
  // been loaded. Move those slots onto their now-known host so the transcript on
  // screen survives; nothing else may change key under a live view.
  if (scopeRef.current.localHostId === null && scope.localHostId !== null) {
    const moved = rekeyUnknownHostSlots(storeRef.current, scope.localHostId);
    const activeSlotKey = activeSlotKeyRef.current;
    if (activeSlotKey !== null) {
      activeSlotKeyRef.current = moved.get(activeSlotKey) ?? activeSlotKey;
    }
  }
  scopeRef.current = scope;
  const activeSessionId = activeSessionIdRef.current;
  if (activeSessionId !== null) {
    activeSlotKeyRef.current = sessionStoreSlotKey(scope, activeSessionId);
  }
  const refreshFromServerRef = useRef<((sessionId: string) => Promise<SessionSlot>) | null>(null);
  const queuedRefreshesRef = useRef(new Map<string, {
    promise: Promise<SessionSlot>;
    resolve: (slot: SessionSlot) => void;
  }>());
  // Bump to force re-render — only when the active session's data changes.
  // Session ids are stable for the whole conversation lifetime (the backend
  // allocates them before the first send), so slots are keyed directly with
  // no alias/redirect indirection.
  const [, setTick] = useState(0);
  const slotKeyOf = useCallback(
    (sessionId: string) => sessionStoreSlotKey(scopeRef.current, sessionId),
    [],
  );
  const notify = useCallback((slotKey: string) => {
    if (slotKey === activeSlotKeyRef.current) {
      setTick(n => n + 1);
    }
  }, []);
  const trimInactiveSlots = useCallback((protectedSlotKey?: string) => {
    const store = storeRef.current;
    while (store.size > MAX_SESSION_SLOTS) {
      const candidate = [...store.entries()].find(([slotKey, slot]) =>
        slotKey !== protectedSlotKey
        && slotKey !== activeSlotKeyRef.current
        && slot.status !== 'streaming'
        && slot._pendingRequests === 0,
      );
      if (!candidate) {
        return;
      }
      store.delete(candidate[0]);
    }
  }, []);

  const touchSlot = useCallback((slotKey: string, slot: SessionSlot) => {
    const store = storeRef.current;
    store.delete(slotKey);
    store.set(slotKey, slot);
    trimInactiveSlots(slotKey);
  }, [trimInactiveSlots]);

  const setActiveSession = useCallback((sessionId: string | null) => {
    const slotKey = sessionId === null ? null : slotKeyOf(sessionId);
    activeSessionIdRef.current = sessionId;
    activeSlotKeyRef.current = slotKey;
    if (slotKey) {
      const slot = storeRef.current.get(slotKey);
      if (slot) {
        touchSlot(slotKey, slot);
      }
    }
    trimInactiveSlots();
  }, [slotKeyOf, touchSlot, trimInactiveSlots]);

  const getSlotByKey = useCallback((slotKey: string): SessionSlot => {
    const store = storeRef.current;
    const slot = store.get(slotKey) ?? createEmptySlot();
    touchSlot(slotKey, slot);
    return slot;
  }, [touchSlot]);

  const getSlot = useCallback(
    (sessionId: string): SessionSlot => getSlotByKey(slotKeyOf(sessionId)),
    [getSlotByKey, slotKeyOf],
  );

  const beginRequest = useCallback((slotKey: string): SessionSlot => {
    const store = storeRef.current;
    const slot = store.get(slotKey) ?? createEmptySlot();
    slot._pendingRequests += 1;
    touchSlot(slotKey, slot);
    return slot;
  }, [touchSlot]);

  const internals: SessionStoreInternals = useMemo(() => ({
    storeRef,
    scopeRef,
    refreshFromServerRef,
    queuedRefreshesRef,
    slotKeyOf,
    notify,
    trimInactiveSlots,
    touchSlot,
    beginRequest,
    runQueuedRefresh: () => undefined,
  }), [beginRequest, notify, slotKeyOf, touchSlot, trimInactiveSlots]);

  const { refreshFromServer, runQueuedRefresh } = useMemo(
    () => createSessionStoreRefreshers(internals),
    [internals],
  );
  internals.runQueuedRefresh = runQueuedRefresh;
  const { fetchFromServer, fetchMore } = useMemo(
    () => createSessionStoreFetchers(internals),
    [internals],
  );
  const {
    appendRealtime,
    appendRealtimeBatch,
    updateStreaming,
    finalizeStreaming,
    clearRealtime,
    reconcileOptimisticUserMessage,
  } = useMemo(
    () => createSessionStoreRealtimeOps(internals, getSlotByKey),
    [internals, getSlotByKey],
  );
  refreshFromServerRef.current = refreshFromServer;

  const has = useCallback((sessionId: string) => {
    return storeRef.current.has(sessionStoreSlotKey(scopeRef.current, sessionId));
  }, []);

  const setStatus = useCallback((sessionId: string, status: SessionStatus) => {
    const slotKey = slotKeyOf(sessionId);
    const slot = getSlotByKey(slotKey);
    slot._loadingTicket = null;
    slot.status = status;
    notify(slotKey);
  }, [getSlotByKey, notify, slotKeyOf]);

  /**
   * Check if a session's data is stale (>30s old).
   */
  const isStale = useCallback((sessionId: string) => {
    const slot = storeRef.current.get(sessionStoreSlotKey(scopeRef.current, sessionId));
    if (!slot) return true;
    return Date.now() - slot.fetchedAt > STALE_THRESHOLD_MS;
  }, []);

  const clear = useCallback(() => {
    const hadActiveSession = activeSlotKeyRef.current !== null;
    storeRef.current.clear();
    activeSlotKeyRef.current = null;
    activeSessionIdRef.current = null;
    if (hadActiveSession) {
      setTick(n => n + 1);
    }
  }, []);


  /**
   * Get merged messages for a session (for rendering).
   *
   * Callers read this on every render (the store signals changes via a tick
   * re-render, not a new store identity), so the empty result must be
   * identity-stable to keep downstream memos from recomputing on no-ops.
   */
  const getMessages = useCallback((sessionId: string): NormalizedMessage[] => {
    return storeRef.current.get(sessionStoreSlotKey(scopeRef.current, sessionId))?.merged ?? EMPTY;
  }, []);

  /**
   * Get session slot (for status, pagination info, etc.).
   */
  const getSessionSlot = useCallback((sessionId: string): SessionSlot | undefined => {
    return storeRef.current.get(sessionStoreSlotKey(scopeRef.current, sessionId));
  }, []);

  return useMemo(() => ({
    getSlot,
    has,
    fetchFromServer,
    fetchMore,
    appendRealtime,
    appendRealtimeBatch,
    refreshFromServer,
    setActiveSession,
    setStatus,
    isStale,
    updateStreaming,
    finalizeStreaming,
    clearRealtime,
    reconcileOptimisticUserMessage,
    clear,
    getMessages,
    getSessionSlot,
  }), [
    getSlot, has, fetchFromServer, fetchMore,
    appendRealtime, appendRealtimeBatch, refreshFromServer,
    setActiveSession, setStatus, isStale, updateStreaming, finalizeStreaming,
    clearRealtime, reconcileOptimisticUserMessage, clear, getMessages, getSessionSlot,
  ]);
}

export type SessionStore = ReturnType<typeof useSessionStore>;
