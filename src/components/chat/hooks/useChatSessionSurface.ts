/**
 * Session-surface state for ChatInterface: the host-scoped session store, the
 * streaming scratch refs, and the provider/session hook composition. Everything
 * here is host- and session-scoped data; view derivation lives in
 * `useChatInterfaceState`. Split from the former `ChatInterface.tsx`.
 */

import { useCallback, useRef } from 'react';

import { useFleetHostCatalog } from '../../../fleet/discovery/FleetHostCatalogContext';
import { useFleetHost, type FleetHostState } from '../../../fleet/FleetSessionRoute';
import { hostChatAvailability } from '../../../fleet/hostAvailability';
import { useHostQualifiedChat } from '../../../fleet/chat/useHostQualifiedChat';
import { useRemoteTranscriptSync } from '../../../fleet/chat/useRemoteTranscriptSync';
import { useSessionStore, type SessionStore } from '../../../stores/useSessionStore';
import type { ChatInterfaceProps } from '../types/types';

import { useChatProviderState } from './useChatProviderState';
import { useChatSessionState } from './useChatSessionState';

type SurfaceProps = Pick<ChatInterfaceProps,
  | 'selectedProject'
  | 'selectedSession'
  | 'processingSessions'
  | 'onSessionIdle'
  | 'externalMessageUpdate'
  | 'newSessionTrigger'
  | 'showImagePreviews'
> & {
  ws: ChatInterfaceProps['ws'];
  sendMessage: ChatInterfaceProps['sendMessage'];
};
export function useChatSessionSurface(props: SurfaceProps) {
  const {
    selectedProject,
    selectedSession,
    ws,
    externalMessageUpdate,
    newSessionTrigger,
    processingSessions,
    onSessionIdle,
    showImagePreviews,
  } = props;

  // Slots and request URLs follow the host that owns the session on screen.
  const fleetHost: FleetHostState = useFleetHost();
  const sessionStore: SessionStore = useSessionStore(fleetHost.storeScope);
  const { catalog } = useFleetHostCatalog();
  // Chat traffic for a peer session travels on the host-qualified channel; the
  // local host keeps the existing app socket. Both are behind one sender, so the
  // composer and session hooks stay host-agnostic.
  const chat = useHostQualifiedChat({
    scope: fleetHost.storeScope,
    session: {
      localId: selectedSession?.id ?? null,
      availability: hostChatAvailability(catalog, fleetHost.storeScope, 'chat.control'),
    },
    sessionStore,
    onSessionIdle,
  });
  const sendMessage = chat.sendMessage;
  useRemoteTranscriptSync({
    scope: fleetHost.storeScope,
    sessionId: selectedSession?.id ?? null,
    catalog,
    refresh: sessionStore.refreshFromServer,
  });
  const streamTimerRef = useRef<number | null>(null);
  const accumulatedStreamRef = useRef('');
  // When each session's `chat.subscribe` was last sent; idle acks older than
  // a later local request are discarded as stale.
  const statusCheckSentAtRef = useRef(new Map<string, number>());
  // Highest live `seq` observed per session. Written by the realtime handler
  // on every sequenced frame, read whenever a `chat.subscribe` is sent so the
  // server replays only the events this client actually missed.
  const lastSeqRef = useRef(new Map<string, number>());

  const resetStreamingState = useCallback(() => {
    if (streamTimerRef.current) {
      clearTimeout(streamTimerRef.current);
      streamTimerRef.current = null;
    }
    accumulatedStreamRef.current = '';
  }, []);

  const provider = useChatProviderState({
    selectedSession,
    selectedProject,
  });

  const session = useChatSessionState({
    selectedProject,
    selectedSession,
    ws,
    sendMessage,
    externalMessageUpdate,
    newSessionTrigger,
    processingSessions,
    onSessionIdle,
    resetStreamingState,
    statusCheckSentAtRef,
    lastSeqRef,
    sessionStore,
    showImagePreviews,
  });

  return {
    fleetHost,
    sessionStore,
    chat,
    streamTimerRef,
    accumulatedStreamRef,
    statusCheckSentAtRef,
    lastSeqRef,
    resetStreamingState,
    provider,
    session,
  };
}

export type ChatSessionSurface = ReturnType<typeof useChatSessionSurface>;
