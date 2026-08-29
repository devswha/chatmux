/**
 * Realtime and streaming operations for the session store: websocket row
 * ingestion and the well-known-id streaming placeholder lifecycle. Split from
 * the former `useSessionStore.ts`.
 */

import type { LLMProvider } from '../../types/app';

import type { SessionStoreInternals } from './internals';
import type { NormalizedMessage, SessionSlot } from './messages';
import { recomputeMergedIfNeeded } from './merge';
import { upsertRealtimeMessages } from './realtime';

export function createSessionStoreRealtimeOps(
  internals: SessionStoreInternals,
  getSlotByKey: (slotKey: string) => SessionSlot,
) {
  const { notify, slotKeyOf, storeRef } = internals;

  const appendRealtime = (sessionId: string, msg: NormalizedMessage) => {
    // A conversation slot only ever holds real messages. Frames without a
    // string id are transport/broadcast envelopes (e.g. discovery.* frames)
    // that would poison every later merge, which matches ids via
    // `id.startsWith(...)`; reject them here instead of crashing downstream.
    if (typeof msg.id !== 'string') {
      console.warn('[SessionStore] dropped a realtime frame without a message id', {
        sessionId,
        kind: (msg as { kind?: unknown }).kind,
      });
      return;
    }
    const slotKey = slotKeyOf(sessionId);
    const slot = getSlotByKey(slotKey);
    const normalizedMessage =
      msg.sessionId === sessionId
        ? msg
        : { ...msg, sessionId };
    slot.realtimeMessages = upsertRealtimeMessages(
      slot.realtimeMessages,
      [normalizedMessage],
    );
    recomputeMergedIfNeeded(slot);
    notify(slotKey);
  };

  const appendRealtimeBatch = (sessionId: string, msgs: NormalizedMessage[]) => {
    // Same id guard as appendRealtime: envelope frames must never enter a slot.
    const messagesWithIds = msgs.filter((msg) => typeof msg.id === 'string');
    if (messagesWithIds.length === 0) return;
    const slotKey = slotKeyOf(sessionId);
    const slot = getSlotByKey(slotKey);
    const normalizedMessages = messagesWithIds.map((msg) =>
      msg.sessionId === sessionId
        ? msg
        : { ...msg, sessionId },
    );
    slot.realtimeMessages = upsertRealtimeMessages(
      slot.realtimeMessages,
      normalizedMessages,
    );
    recomputeMergedIfNeeded(slot);
    notify(slotKey);
  };

  const updateStreaming = (sessionId: string, accumulatedText: string, msgProvider: LLMProvider) => {
    const slotKey = slotKeyOf(sessionId);
    const slot = getSlotByKey(slotKey);
    const streamId = `__streaming_${sessionId}`;
    const msg: NormalizedMessage = {
      id: streamId,
      sessionId,
      timestamp: new Date().toISOString(),
      provider: msgProvider,
      kind: 'stream_delta',
      content: accumulatedText,
    };
    const idx = slot.realtimeMessages.findIndex(m => m.id === streamId);
    if (idx >= 0) {
      slot.realtimeMessages = [...slot.realtimeMessages];
      slot.realtimeMessages[idx] = msg;
    } else {
      slot.realtimeMessages = [...slot.realtimeMessages, msg];
    }
    recomputeMergedIfNeeded(slot);
    notify(slotKey);
  };

  /**
   * Finalize streaming: convert the streaming message to a regular text message.
   * The well-known streaming ID is replaced with a unique text message ID.
   */
  const finalizeStreaming = (sessionId: string) => {
    const slotKey = slotKeyOf(sessionId);
    const slot = storeRef.current.get(slotKey);
    if (!slot) return;
    const streamId = `__streaming_${sessionId}`;
    const idx = slot.realtimeMessages.findIndex(m => m.id === streamId);
    if (idx >= 0) {
      const stream = slot.realtimeMessages[idx];
      slot.realtimeMessages = [...slot.realtimeMessages];
      slot.realtimeMessages[idx] = {
        ...stream,
        id: `text_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        kind: 'text',
        role: 'assistant',
      };
      recomputeMergedIfNeeded(slot);
      notify(slotKey);
    }
  };

  /**
   * Clear realtime messages for a session (e.g., after stream completes and server fetch catches up).
   */
  const clearRealtime = (sessionId: string) => {
    const slotKey = slotKeyOf(sessionId);
    const slot = storeRef.current.get(slotKey);
    if (slot) {
      slot.realtimeMessages = [];
      recomputeMergedIfNeeded(slot);
      notify(slotKey);
    }
  };

  const reconcileOptimisticUserMessage = (
    sessionId: string,
    content: string,
    authoritativeBaseline: number,
  ): void => {
    const slotKey = slotKeyOf(sessionId);
    const slot = storeRef.current.get(slotKey);
    if (slot === undefined) return;
    const authoritativeCount = slot.serverMessages.filter((message) =>
      message.kind === 'text' && message.role === 'user' && message.content?.trim() === content,
    ).length;
    const removeCount = authoritativeCount - authoritativeBaseline;
    if (removeCount <= 0) return;
    const indexes = slot.realtimeMessages
      .map((message, index) => ({ message, index }))
      .filter(({ message }) =>
        message.kind === 'text' && message.role === 'user' && message.content?.trim() === content,
      )
      .slice(-removeCount)
      .map(({ index }) => index);
    if (indexes.length === 0) return;
    const removed = new Set(indexes);
    slot.realtimeMessages = slot.realtimeMessages.filter((_message, index) => !removed.has(index));
    recomputeMergedIfNeeded(slot);
    notify(slotKey);
  };

  return {
    appendRealtime,
    appendRealtimeBatch,
    updateStreaming,
    finalizeStreaming,
    clearRealtime,
    reconcileOptimisticUserMessage,
  };
}
