/**
 * Interface state for ChatInterface: composer composition, realtime event
 * wiring, reconnect resubscribe, the abort shortcut, and the permission
 * context. Split from the former `ChatInterface.tsx`; consumes the session
 * surface from `useChatSessionSurface`.
 */

import { useCallback, useEffect, useMemo, useRef } from 'react';

import type { ChatInterfaceProps } from '../types/types';

import { useChatComposerState } from './useChatComposerState';
import { useChatLiveRefresh } from './useChatLiveRefresh';
import { useChatRealtimeHandlers } from './useChatRealtimeHandlers';
import { useChatRelayAsk } from './useChatRelayAsk';
import type { ChatSessionSurface } from './useChatSessionSurface';

type InterfaceStateProps = ChatInterfaceProps & {
  surface: ChatSessionSurface;
};

export function useChatInterfaceState(props: InterfaceStateProps) {
  const {
    selectedProject,
    selectedSession,
    isSessionReadOnly,
    liveSessionTarget,
    liveSessionKind,
    sendByCtrlEnter,
    onFileOpen,
    onInputFocusChange,
    onSessionProcessing,
    onSessionIdle,
    onNavigateToSession,
    onSessionEstablished,
    onShowSettings,
    surface,
  } = props;
  const {
    sessionStore,
    chat,
    streamTimerRef,
    accumulatedStreamRef,
    statusCheckSentAtRef,
    lastSeqRef,
    resetStreamingState,
    provider: providerState,
    session,
  } = surface;
  // One sender and one event source for the open session's owning host: local
  // sessions keep the app socket, a peer session uses its host-qualified channel.
  const { admitSubmit, sendMessage, subscribe } = chat;

  // Brand-new conversation: the composer allocated a stable session id via
  // the session gateway before the first send. Record it locally and put it
  // in the URL — this id never changes again, so there is no later handoff.
  const { setCurrentSessionId } = session;
  const handleSessionEstablished = useCallback<NonNullable<ChatInterfaceProps['onSessionEstablished']>>((sessionId, context) => {
    setCurrentSessionId(sessionId);
    onSessionEstablished?.(sessionId, context);
    onNavigateToSession?.(sessionId);
  }, [setCurrentSessionId, onSessionEstablished, onNavigateToSession]);

  const composerState = useChatComposerState({
    selectedProject,
    selectedSession,
    currentSessionId: session.currentSessionId,
    provider: providerState.provider,
    permissionMode: providerState.permissionMode,
    cyclePermissionMode: providerState.cyclePermissionMode,
    cursorModel: providerState.cursorModel,
    claudeModel: providerState.claudeModel,
    codexModel: providerState.codexModel,
    currentProviderEffort: providerState.currentProviderEffort,
    opencodeModel: providerState.opencodeModel,
    ompModel: providerState.ompModel,
    isLoading: session.isProcessing,
    isSessionReadOnly,
    canAbortSession: session.canAbortSession,
    tokenBudget: session.tokenBudget,
    sendMessage,
    sendByCtrlEnter,
    onSessionProcessing,
    onSessionEstablished: handleSessionEstablished,
    onInputFocusChange,
    onFileOpen,
    onShowSettings,
    scrollToBottom: session.scrollToBottom,
    addMessage: session.addMessage,
    setIsUserScrolledUp: session.setIsUserScrolledUp,
    setPendingPermissionRequests: providerState.setPendingPermissionRequests,
    resolvePermissionModeForProvider: providerState.resolvePermissionModeForProvider,
  });

  const submitRef = useRef(composerState.handleSubmit);
  submitRef.current = composerState.handleSubmit;
  const handleSubmit = useCallback<typeof composerState.handleSubmit>(async (event) => {
    if (!admitSubmit()) return;
    await submitRef.current(event);
  }, [admitSubmit]);
  const composer = useMemo(
    () => ({ ...composerState, handleSubmit }),
    [composerState, handleSubmit],
  );

  // On WebSocket reconnect, re-fetch the current session's messages from the
  // server so missed streaming events are shown, then re-subscribe — the
  // `chat_subscribed` ack restores or clears the activity indicator, replays
  // missed live events, and re-attaches a still-running stream to this socket.
  const handleWebSocketReconnect = useCallback(async () => {
    if (!selectedProject || !selectedSession) return;
    await sessionStore.refreshFromServer(selectedSession.id);
    statusCheckSentAtRef.current.set(selectedSession.id, Date.now());
    sendMessage({
      type: 'chat.subscribe',
      sessions: [{
        sessionId: selectedSession.id,
        lastSeq: lastSeqRef.current.get(selectedSession.id) ?? 0,
      }],
    });
  }, [selectedProject, selectedSession, sendMessage, sessionStore, statusCheckSentAtRef, lastSeqRef]);

  useChatLiveRefresh({
    selectedSession,
    liveSessionTarget,
    liveSessionKind,
    isSessionReadOnly,
    refreshCurrentMessages: session.refreshCurrentMessages,
    refreshFromServer: sessionStore.refreshFromServer,
  });

  useChatRealtimeHandlers({
    subscribe,
    provider: providerState.provider,
    selectedSession,
    currentSessionId: session.currentSessionId,
    setTokenBudget: session.setTokenBudget,
    pendingPermissionRequests: providerState.pendingPermissionRequests,
    setPendingPermissionRequests: providerState.setPendingPermissionRequests,
    streamTimerRef,
    accumulatedStreamRef,
    lastSeqRef,
    statusCheckSentAtRef,
    onSessionProcessing,
    onSessionIdle,
    onWebSocketReconnect: handleWebSocketReconnect,
    sessionStore,
  });

  const canAbortSession = session.canAbortSession;
  const { handleAbortSession } = composer;
  useEffect(() => {
    if (!canAbortSession) {
      return;
    }

    const handleGlobalEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.repeat || event.defaultPrevented) {
        return;
      }

      event.preventDefault();
      handleAbortSession();
    };

    document.addEventListener('keydown', handleGlobalEscape, { capture: true });
    return () => {
      document.removeEventListener('keydown', handleGlobalEscape, { capture: true });
    };
  }, [canAbortSession, handleAbortSession]);

  useEffect(() => {
    return () => {
      resetStreamingState();
    };
  }, [resetStreamingState]);

  const permissionContextValue = useMemo(() => ({
    pendingPermissionRequests: providerState.pendingPermissionRequests,
    handlePermissionDecision: composer.handlePermissionDecision,
  }), [providerState.pendingPermissionRequests, composer.handlePermissionDecision]);

  // Mirrors ChatComposer's own visibility check so the message pane can
  // reserve enough bottom space to keep the floating status tab from
  // overlapping the last message.
  const hasActivityIndicator = Boolean(
    session.sessionActivity && providerState.pendingPermissionRequests.length === 0,
  );

  const relayAsk = useChatRelayAsk({
    isSessionReadOnly,
    liveSessionKind,
    chatMessages: session.chatMessages,
  });

  return { composer, permissionContextValue, hasActivityIndicator, relayAsk };
}
