/**
 * Live-refresh effects for the chat surface.
 *
 * External CLI kinds refresh on the faster visibility interval; gjc and
 * cwd-fallback live sessions (liveSessionKind === null: in liveSessionIds
 * without confirmed lineage) have no other refresh path, so the bounded poll
 * keeps covering both. Split from the former `ChatInterface.tsx`.
 */

import { useEffect, useRef } from 'react';

import type { SessionStore } from '../../../stores/useSessionStore';
import type { ChatInterfaceProps } from '../types/types';

type LiveRefreshArgs = {
  selectedSession: ChatInterfaceProps['selectedSession'];
  liveSessionTarget: ChatInterfaceProps['liveSessionTarget'];
  liveSessionKind: ChatInterfaceProps['liveSessionKind'];
  isSessionReadOnly: ChatInterfaceProps['isSessionReadOnly'];
  refreshCurrentMessages: () => Promise<unknown>;
  refreshFromServer: SessionStore['refreshFromServer'];
};

export function useChatLiveRefresh({
  selectedSession,
  liveSessionTarget,
  liveSessionKind,
  isSessionReadOnly,
  refreshCurrentMessages,
  refreshFromServer,
}: LiveRefreshArgs): void {
  useEffect(() => {
    if (
      !selectedSession
      || !liveSessionTarget
      || !liveSessionKind
      || liveSessionKind === 'gjc'
    ) {
      return;
    }
    const refresh = () => {
      if (document.visibilityState === 'visible') {
        void refreshCurrentMessages();
      }
    };
    refresh();
    const timer = window.setInterval(refresh, 1_500);
    return () => window.clearInterval(timer);
  }, [
    selectedSession,
    liveSessionTarget,
    liveSessionKind,
    refreshCurrentMessages,
  ]);

  // A live (tmux-driven) session grows from an EXTERNAL gjc process, so ChatMux
  // gets no realtime WS push for it — the open read-only view would otherwise
  // stay frozen until the user leaves and re-enters. Ref keeps refreshFromServer
  // out of the effect deps.
  const refreshFromServerRef = useRef(refreshFromServer);
  refreshFromServerRef.current = refreshFromServer;
  const liveOpenSessionId =
    isSessionReadOnly && (liveSessionKind === 'gjc' || liveSessionKind == null)
      ? (selectedSession?.id ?? null)
      : null;
  useEffect(() => {
    if (!liveOpenSessionId) {
      return;
    }
    const timer = setInterval(() => {
      void refreshFromServerRef.current(liveOpenSessionId);
    }, 5000);
    return () => clearInterval(timer);
  }, [liveOpenSessionId]);
}
