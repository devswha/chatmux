/**
 * Chat transport for the session on screen, qualified by its owning host.
 *
 * The chat composer and session hooks are given one `sendMessage`/`subscribe`
 * pair and know nothing about hosts. This hook is that pair: for a local session
 * it is the existing app websocket, unchanged; for a session owned by a peer it
 * is the hub's host-qualified `/remote-chat` channel, and hub-local chat frames
 * are withheld because the same session id there names a different session.
 *
 * A dispatched mutation that loses its connection before acknowledgement is
 * reported as a non-success uncertain outcome. It is never resent: the transcript
 * is re-read from the owning host, and only after that reconciliation may the
 * user act again.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useWebSocket, type ServerEvent } from '../../contexts/WebSocketContext';
import type { MarkSessionIdle } from '../../hooks/useSessionProtection';
import type { SessionStore } from '../../stores/useSessionStore';
import type { HostScope } from '../hostApi/urls';

import {
  type ChatBlockReason,
  type HostChatAvailability,
  routeChatFrame,
} from './chatFrames';
import {
  type ChatSocketLike,
  createRemoteChatChannel,
  type RemoteChatChannel,
  type RemoteChatEvent,
} from './remoteChatChannel';

export type RemoteSendUncertainty = {
  readonly hostId: string;
  readonly sessionId: string;
  readonly operation: 'chat.send' | 'chat.abort';
  readonly status: 'reconciling' | 'reconciled';
  /** Whether the host's own transcript shows the request as applied. */
  readonly evidence: 'unknown' | 'applied' | 'not-applied';
};

export type HostQualifiedChat = {
  readonly sendMessage: (message: unknown) => void;
  /** Synchronous user-action gate, evaluated before the composer mutates UI state. */
  readonly admitSubmit: () => boolean;
  readonly subscribe: (listener: (event: ServerEvent) => void) => () => void;
  /** Non-null while a dispatched mutation's outcome is unresolved or just resolved. */
  readonly uncertainty: RemoteSendUncertainty | null;
  /** Why the last frame was refused, for the composer's non-success state. */
  readonly blocked: ChatBlockReason | null;
  readonly acknowledge: () => void;
};

export type HostQualifiedChatInput = {
  readonly scope: HostScope;
  readonly session: {
    readonly localId: string | null;
    readonly availability: HostChatAvailability;
  };
  readonly sessionStore: SessionStore;
  readonly onSessionIdle?: MarkSessionIdle;
  /** Socket factory seam; production uses the browser websocket. */
  readonly connect?: () => ChatSocketLike;
};

/** Remote acknowledgement frames translated into the local chat protocol. */
function translateFrame(frame: ServerEvent, sessionId: string): ServerEvent | null {
  switch (frame.kind) {
    case 'chat_aborted':
      // The unified terminal event: the run stopped because the abort landed.
      return { kind: 'complete', sessionId, aborted: true };
    case 'chat_subscribed':
    case 'protocol_error':
      return { ...frame, sessionId };
    case 'chat_accepted':
    case 'chat_permission_resolved':
    case 'chat_prompt_resolved':
    case 'chat_approval_resolved':
      // The run's events describe accepted mutations and resolved prompts.
      return null;
    default:
      // Provider messages and the reconnect signal use the same protocol as the
      // local socket. Only the owning session id is normalized here.
      return frame.kind === 'websocket_reconnected' ? frame : { ...frame, sessionId };
  }
}

function contentOf(message: unknown): string | null {
  return typeof message === 'object' && message !== null && 'content' in message
    && typeof (message as { content?: unknown }).content === 'string'
    ? (message as { content: string }).content
    : null;
}

export function useHostQualifiedChat(input: HostQualifiedChatInput): HostQualifiedChat {
  const { sendMessage: sendLocal, subscribe: subscribeLocal } = useWebSocket();
  const { scope, session, sessionStore, onSessionIdle } = input;
  const [uncertainty, setUncertainty] = useState<RemoteSendUncertainty | null>(null);
  const [blocked, setBlocked] = useState<ChatBlockReason | null>(null);
  const listenersRef = useRef(new Set<(event: ServerEvent) => void>());
  const channelRef = useRef<RemoteChatChannel | null>(null);
  const lastSentRef = useRef<Readonly<{ readonly content: string; readonly baseline: number }> | null>(null);
  const isRemote = scope.hostId !== null && scope.hostId !== scope.localHostId;
  const currentRef = useRef({ scope, session, uncertainty });
  currentRef.current = { scope, session, uncertainty };

  const dispatch = useCallback((event: ServerEvent) => {
    for (const listener of [...listenersRef.current]) listener(event);
  }, []);

  /**
   * Reads the owning host's transcript to decide whether the uncertain request
   * was applied. A read may be retried after a reconnect; a mutation may not.
   */
  const reconcile = useCallback(async (
    pending: RemoteSendUncertainty,
    sent: Readonly<{ readonly content: string; readonly baseline: number }> | null,
  ) => {
    const slot = await sessionStore.refreshFromServer(pending.sessionId);
    const matchingInputs = sent === null ? 0 : slot.serverMessages.filter((message) =>
      message.kind === 'text'
      && message.role === 'user'
      && message.content?.trim() === sent.content,
    ).length;
    const applied = sent === null
      ? 'unknown'
      : matchingInputs > sent.baseline ? 'applied' : 'not-applied';
    if (applied === 'applied' && sent !== null) {
      sessionStore.reconcileOptimisticUserMessage(pending.sessionId, sent.content, sent.baseline);
    }
    setUncertainty({ ...pending, status: 'reconciled', evidence: applied });
  }, [sessionStore]);

  const onChannelEvent = useCallback((event: RemoteChatEvent) => {
    if (event.kind === 'frame') {
      const translated = session.localId === null ? null : translateFrame(event.frame, session.localId);
      if (translated !== null) dispatch(translated);
      return;
    }
    const pending: RemoteSendUncertainty = {
      hostId: event.hostId,
      sessionId: event.sessionId,
      operation: event.operation,
      status: 'reconciling',
      evidence: 'unknown',
    };
    setUncertainty(pending);
    // The run's outcome is unknown, so it is not running: the indicator must stop
    // instead of spinning against a host that may never answer.
    onSessionIdle?.(event.sessionId);
    void reconcile(pending, lastSentRef.current);
  }, [dispatch, onSessionIdle, reconcile, session.localId]);

  const eventRef = useRef(onChannelEvent);
  eventRef.current = onChannelEvent;

  useEffect(() => {
    if (!isRemote || scope.hostId === null) return undefined;
    const channel = createRemoteChatChannel({
      hostId: scope.hostId,
      onEvent: (event) => eventRef.current(event),
      connect: input.connect,
    });
    channelRef.current = channel;
    return () => {
      channelRef.current = null;
      channel.close();
    };
    // The channel belongs to one host: a host switch must dispose it, and nothing
    // else may.
  }, [input.connect, isRemote, scope.hostId]);

  useEffect(() => {
    setUncertainty(null);
    setBlocked(null);
  }, [scope.hostId, session.localId]);

  const admitSubmit = useCallback((): boolean => {
    const current = currentRef.current;
    const remote = current.scope.hostId !== null
      && current.scope.hostId !== current.scope.localHostId;
    if (!remote) return true;
    if (current.uncertainty?.status === 'reconciling') {
      setBlocked('reconcile-required');
      return false;
    }
    if (current.session.availability !== 'ready') {
      setBlocked(current.session.availability === 'syncing' ? 'host-syncing' : 'host-unavailable');
      return false;
    }
    setBlocked(null);
    return true;
  }, []);

  const sendMessage = useCallback((message: unknown) => {
    const routing = routeChatFrame(message, {
      hostId: scope.hostId,
      localHostId: scope.localHostId,
      sessionId: session.localId,
      availability: session.availability,
      reconcileRequired: uncertainty?.status === 'reconciling',
    });
    switch (routing.kind) {
      case 'local':
        setBlocked(null);
        sendLocal(message);
        return;
      case 'remote': {
        const channel = channelRef.current;
        if (channel === null) {
          setBlocked('host-unavailable');
          return;
        }
        setBlocked(null);
        const content = contentOf(message)?.trim() ?? null;
        if (content !== null) {
          const baseline = session.localId === null ? 0 : sessionStore.getSessionSlot(session.localId)
            ?.serverMessages.filter((entry) =>
              entry.kind === 'text' && entry.role === 'user' && entry.content?.trim() === content,
            ).length ?? 0;
          lastSentRef.current = { content, baseline };
        }
        // Transport recovery subscriptions are automatic and must not dismiss an
        // uncertain mutation. Only a fresh user mutation after reconciliation
        // acknowledges that result.
        const userMutation = routing.frames.some((frame) =>
          frame.type === 'chat.send' || frame.type === 'chat.abort');
        if (uncertainty?.status === 'reconciled' && userMutation) setUncertainty(null);
        channel.send(routing.frames);
        return;
      }
      case 'blocked':
        setBlocked(routing.reason);
        return;
    }
  }, [scope.hostId, scope.localHostId, sendLocal, session.availability, session.localId, sessionStore, uncertainty]);

  const subscribe = useCallback((listener: (event: ServerEvent) => void) => {
    listenersRef.current.add(listener);
    const releaseLocal = subscribeLocal((event) => {
      // While a peer's session is open, hub chat frames describe a different
      // session that merely shares the id. Only connectivity is shared.
      if (isRemote && event.kind !== 'websocket_reconnected') return;
      listener(event);
    });
    return () => {
      listenersRef.current.delete(listener);
      releaseLocal();
    };
  }, [isRemote, subscribeLocal]);

  const acknowledge = useCallback(() => setUncertainty(null), []);

  return useMemo(
    () => ({ sendMessage, admitSubmit, subscribe, uncertainty, blocked, acknowledge }),
    [acknowledge, admitSubmit, blocked, sendMessage, subscribe, uncertainty],
  );
}
