/**
 * Merging for the session store: combines the persisted server window with live
 * realtime rows into the render-ready transcript. Split from the former
 * `useSessionStore.ts` — import from there (the facade), not here.
 */

import {
  compareMessagesChronologically,
  dedupeAdjacentAssistantEchoes,
  hasServerEchoForLocalUser,
  isAssistantTextEchoedInSameTurnOnServer,
} from './echoes';
import type { NormalizedMessage, SessionSlot } from './messages';

export function pruneRealtimeSupersededByServer(
  serverMessages: NormalizedMessage[],
  realtimeMessages: NormalizedMessage[],
): NormalizedMessage[] {
  if (realtimeMessages.length === 0) {
    return realtimeMessages;
  }

  const serverIds = new Set(serverMessages.map((message) => message.id).filter(Boolean));

  return realtimeMessages.filter((message) => {
    // Defensive recovery: an id-less row can only be a foreign envelope frame
    // that slipped in before ingestion guards existed. Drop it so one bad row
    // cannot freeze the conversation forever.
    if (typeof message.id !== 'string') {
      return false;
    }
    if (message.id && serverIds.has(message.id)) {
      return false;
    }

    if (message.id.startsWith('local_') && hasServerEchoForLocalUser(message, serverMessages)) {
      return false;
    }

    if (message.kind === 'stream_delta' || message.id === `__streaming_${message.sessionId}`) {
      if (isAssistantTextEchoedInSameTurnOnServer(message, serverMessages, realtimeMessages)) {
        return false;
      }
      return true;
    }

    if (
      message.kind === 'text'
      && message.role === 'assistant'
      && message.id.startsWith('text_')
    ) {
      if (isAssistantTextEchoedInSameTurnOnServer(message, serverMessages, realtimeMessages)) {
        return false;
      }
      return true;
    }

    if (message.kind === 'text' && message.role === 'user') {
      return !hasServerEchoForLocalUser(message, serverMessages);
    }

    if (message.kind === 'tool_use' && message.toolId) {
      if (serverMessages.some((serverMessage) => serverMessage.kind === 'tool_use' && serverMessage.toolId === message.toolId)) {
        return false;
      }
    }

    return true;
  });
}

export function computeMerged(server: NormalizedMessage[], realtime: NormalizedMessage[]): NormalizedMessage[] {
  if (realtime.length === 0) {
    return server;
  }
  if (server.length === 0) {
    return dedupeAdjacentAssistantEchoes(realtime);
  }

  const serverIds = new Set(server.map((message) => message.id).filter(Boolean));
  const seenRealtimeIds = new Set<string>();
  const extra = realtime.filter((message) => {
    // Same defensive recovery as pruneRealtimeSupersededByServer: an id-less
    // row is a foreign envelope frame, never a conversation message.
    if (typeof message.id !== 'string') {
      return false;
    }
    if (message.id && seenRealtimeIds.has(message.id)) {
      return false;
    }
    if (message.id) {
      seenRealtimeIds.add(message.id);
    }
    if (message.id && serverIds.has(message.id)) {
      return false;
    }
    // Optimistic user rows use `local_*` ids; once the same text exists on the
    // server-backed copy from the same send window, drop the realtime echo to
    // avoid duplicate bubbles without hiding repeated prompts from history.
    if (message.id.startsWith('local_')) {
      if (hasServerEchoForLocalUser(message, server)) {
        return false;
      }
    }
    if (
      message.kind === 'text'
      && message.role === 'assistant'
      && message.id.startsWith('text_')
      && isAssistantTextEchoedInSameTurnOnServer(message, server, realtime)
    ) {
      return false;
    }
    return true;
  });

  if (extra.length === 0) {
    return server;
  }

  // Interleave by timestamp so live rows stay with their turn instead of
  // piling up at the bottom after every refresh.
  return dedupeAdjacentAssistantEchoes(
    [...server, ...extra].sort(compareMessagesChronologically),
  );
}

/**
 * Recompute slot.merged only when the input arrays have actually changed
 * (by reference). Returns true if merged was recomputed.
 */
export function recomputeMergedIfNeeded(slot: SessionSlot): boolean {
  if (slot.serverMessages === slot._lastServerRef && slot.realtimeMessages === slot._lastRealtimeRef) {
    return false;
  }
  slot._lastServerRef = slot.serverMessages;
  slot._lastRealtimeRef = slot.realtimeMessages;
  slot.merged = computeMerged(slot.serverMessages, slot.realtimeMessages);
  return true;
}

// ─── Stale threshold ─────────────────────────────────────────────────────────
