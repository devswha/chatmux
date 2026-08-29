/**
 * The session store's internals, shared between the hook and the server-request
 * factories. This object is the store's own plumbing — refs and slot helpers the
 * factories must mutate — assembled once per hook instance and read at call time.
 * Not part of the public store API.
 */

import type { MutableRefObject } from 'react';

import type { SessionStoreScope } from '../sessionStoreScope';

import type { SessionSlot } from './messages';

export type QueuedRefresh = {
  promise: Promise<SessionSlot>;
  resolve: (slot: SessionSlot) => void;
};

export type SessionStoreInternals = {
  storeRef: MutableRefObject<Map<string, SessionSlot>>;
  scopeRef: MutableRefObject<SessionStoreScope>;
  refreshFromServerRef: MutableRefObject<((sessionId: string) => Promise<SessionSlot>) | null>;
  queuedRefreshesRef: MutableRefObject<Map<string, QueuedRefresh>>;
  slotKeyOf: (sessionId: string) => string;
  notify: (slotKey: string) => void;
  trimInactiveSlots: (protectedSlotKey?: string) => void;
  touchSlot: (slotKey: string, slot: SessionSlot) => void;
  beginRequest: (slotKey: string) => SessionSlot;
  runQueuedRefresh: (sessionId: string, slotKey: string, slot: SessionSlot) => void;
};
