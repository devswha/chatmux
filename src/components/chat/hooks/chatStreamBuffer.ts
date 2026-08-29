/**
 * Streaming accumulation for the chat realtime handlers: deltas are buffered
 * and flushed to the store on a short timer so a fast stream does not re-render
 * per token. Split from the former `useChatRealtimeHandlers.ts`.
 */

import type { MutableRefObject } from 'react';

import type { LLMProvider } from '../../../types/app';
import type { SessionStore } from '../../../stores/useSessionStore';

const STREAM_FLUSH_MS = 100;

export function bufferStreamDelta(
  refs: {
    streamTimerRef: MutableRefObject<number | null>;
    accumulatedStreamRef: MutableRefObject<string>;
  },
  sessionStore: SessionStore,
  sessionId: string | null,
  provider: LLMProvider,
  text: string,
): void {
  refs.accumulatedStreamRef.current += text;
  if (!refs.streamTimerRef.current) {
    refs.streamTimerRef.current = window.setTimeout(() => {
      refs.streamTimerRef.current = null;
      if (sessionId) {
        sessionStore.updateStreaming(sessionId, refs.accumulatedStreamRef.current, provider);
      }
    }, STREAM_FLUSH_MS);
  }
}

/**
 * Flushes the buffered text into the store. `stream_end` finalizes the stream
 * placeholder even when nothing buffered (the placeholder may already be on
 * screen); a trailing `complete` only finalizes when this socket still holds
 * unflushed text — an empty flush must not convert another session's stream.
 */
export function flushStreamBuffer(
  refs: {
    streamTimerRef: MutableRefObject<number | null>;
    accumulatedStreamRef: MutableRefObject<string>;
  },
  sessionStore: SessionStore,
  sessionId: string | null,
  provider: LLMProvider,
  finalize: 'always' | 'when-buffered',
): void {
  if (refs.streamTimerRef.current) {
    clearTimeout(refs.streamTimerRef.current);
    refs.streamTimerRef.current = null;
  }
  if (sessionId && refs.accumulatedStreamRef.current) {
    sessionStore.updateStreaming(sessionId, refs.accumulatedStreamRef.current, provider);
    sessionStore.finalizeStreaming(sessionId);
  } else if (sessionId && finalize === 'always') {
    sessionStore.finalizeStreaming(sessionId);
  }
  refs.accumulatedStreamRef.current = '';
}
