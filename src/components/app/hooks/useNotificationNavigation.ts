/**
 * Handles service-worker `notification:navigate` messages: a completion click
 * focuses the app and routes to the session on the installation that produced
 * it. Legacy payloads carry no host and stay local-only.
 * Split from the former `AppContent.tsx`.
 */

import { useEffect } from 'react';

export type NotificationNavigationWiring = {
  navigate: (path: string) => void;
  sessionPathFor: (hostId: unknown, localId: string) => string;
  refreshProjectsSilently: () => Promise<unknown>;
  setActiveTab: (tab: 'chat') => void;
  setSidebarOpen: (open: boolean) => void;
  clearExternalTerminal: () => void;
};

export function useNotificationNavigation(wiring: NotificationNavigationWiring): void {
  const {
    navigate,
    sessionPathFor,
    refreshProjectsSilently,
    setActiveTab,
    setSidebarOpen,
    clearExternalTerminal,
  } = wiring;

  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
      return undefined;
    }

    const handleServiceWorkerMessage = (event: MessageEvent) => {
      const message = event.data;
      if (!message || message.type !== 'notification:navigate') {
        return;
      }

      if (typeof message.provider === 'string' && message.provider.trim()) {
        localStorage.setItem('selected-provider', message.provider);
      }

      clearExternalTerminal();
      setActiveTab('chat');
      setSidebarOpen(false);
      void refreshProjectsSilently();

      if (typeof message.sessionId === 'string' && message.sessionId) {
        // A completion payload names the installation that produced it. Without
        // one the notification is a legacy local payload, and the local host is
        // the only host it may open.
        navigate(sessionPathFor(message.hostId, message.sessionId));
        return;
      }

      navigate('/');
    };

    navigator.serviceWorker.addEventListener('message', handleServiceWorkerMessage);

    return () => {
      navigator.serviceWorker.removeEventListener('message', handleServiceWorkerMessage);
    };
  }, [navigate, refreshProjectsSilently, sessionPathFor, setActiveTab, setSidebarOpen, clearExternalTerminal]);
}
