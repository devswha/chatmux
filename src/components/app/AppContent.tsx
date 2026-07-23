import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import Sidebar from '../sidebar/view/Sidebar';
import MainContent from '../main-content/view/MainContent';
import CommandPalette from '../command-palette/CommandPalette';
import { useWebSocket } from '../../contexts/WebSocketContext';
import { PaletteOpsProvider, usePaletteOpsRegister } from '../../contexts/PaletteOpsContext';
import { useDeviceSettings } from '../../hooks/useDeviceSettings';
import { useSessionProtection } from '../../hooks/useSessionProtection';
import { useProjectsState } from '../../hooks/useProjectsState';
import { useQueuedMessageAutoSend } from '../../hooks/useQueuedMessageAutoSend';
import { api } from '../../utils/api';
import type { ExternalTerminalTarget } from '../../types/app';

type RunningSessionApiItem = {
  sessionId?: unknown;
  startedAt?: unknown;
  statusText?: unknown;
  canInterrupt?: unknown;
};

type RunningSessionsApiPayload = {
  data?: {
    sessions?: RunningSessionApiItem[];
  };
};

const parseStartedAt = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value;
  }

  if (typeof value !== 'string') {
    return undefined;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

export default function AppContent() {
  return (
    <PaletteOpsProvider>
      <AppContentInner />
    </PaletteOpsProvider>
  );
}

function AppContentInner() {
  const navigate = useNavigate();
  const { sessionId } = useParams<{ sessionId?: string }>();
  const { t } = useTranslation('common');
  const { isMobile } = useDeviceSettings({ trackPWA: false });
  const { ws, sendMessage, subscribe } = useWebSocket();

  const {
    processingSessions,
    markSessionProcessing,
    markSessionIdle,
    syncProcessingSessions,
  } = useSessionProtection();

  const {
    selectedProject,
    selectedSession,
    liveSessionModels,
    activeTab,
    sidebarOpen,
    isLoadingProjects,
    externalMessageUpdate,
    newSessionTrigger,
    setActiveTab,
    setSidebarOpen,
    setIsInputFocused,
    openSettings,
    refreshProjectsSilently,
    registerOptimisticSession,
    sidebarSharedProps,
    handleNewSession,
  } = useProjectsState({
    sessionId,
    navigate,
    subscribe,
    isMobile,
    activeSessions: processingSessions,
  });

  // Local coding-agent targets switch to structured transcripts when indexed;
  // terminal attach is only the fallback before indexing and for remote SSH.
  const [externalTerminal, setExternalTerminal] = useState<ExternalTerminalTarget | null>(null);
  const [externalTranscript, setExternalTranscript] = useState<ExternalTerminalTarget | null>(null);
  const selectExternalProject = sidebarSharedProps.onProjectSelect;
  const selectExternalSession = sidebarSharedProps.onSessionSelect;

  const openExternalTerminal = useCallback((target: ExternalTerminalTarget) => {
    if (target.cliKind !== 'gjc' && target.cliKind !== 'ssh' && target.transcriptSessionId) {
      setExternalTerminal(null);
      setExternalTranscript(target);
      setActiveTab('chat');
      selectExternalProject(target.project);
      selectExternalSession({
        id: target.transcriptSessionId,
        summary: target.sessionName ?? '',
        __provider: target.cliKind,
        __projectId: target.project.projectId,
      });
      setSidebarOpen(false);
      return;
    }
    setExternalTranscript(null);
    setExternalTerminal(target);
    setSidebarOpen(false);
  }, [selectExternalProject, selectExternalSession, setActiveTab, setSidebarOpen]);

  const closeExternalTerminal = useCallback(() => {
    setExternalTerminal(null);
  }, []);

  useEffect(() => {
    if (
      !externalTerminal
      || externalTerminal.cliKind === 'gjc'
      || externalTerminal.cliKind === 'ssh'
      || externalTerminal.transcriptSessionId
    ) return undefined;
    let cancelled = false;
    const poll = async () => {
      try {
        const response = await api.externalSessions();
        if (!response.ok || cancelled) return;
        const body = await response.json();
        const sessions = body?.data?.externalSessions ?? [];
        const ready = sessions.find((session: {
          tmuxName?: unknown;
          transcriptSessionId?: unknown;
          sessionName?: unknown;
          model?: unknown;
        }) => (
          session.tmuxName === externalTerminal.tmuxName
          && typeof session.transcriptSessionId === 'string'
        ));
        if (!cancelled && ready) {
          openExternalTerminal({
            ...externalTerminal,
            transcriptSessionId: ready.transcriptSessionId,
            sessionName: typeof ready.sessionName === 'string' ? ready.sessionName : externalTerminal.sessionName,
            model: typeof ready.model === 'string' ? ready.model : externalTerminal.model,
          });
        }
      } catch {
        // Best-effort: the sidebar poll can still complete the same handoff.
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [externalTerminal, openExternalTerminal]);

  useEffect(() => {
    if (externalTerminal?.cliKind !== 'gjc') return undefined;
    let cancelled = false;
    let resolving = false;
    const poll = async () => {
      if (resolving) return;
      try {
        const response = await api.liveSessions();
        if (!response.ok || cancelled) return;
        const body = await response.json();
        const sessions = (body?.data?.liveSessions ?? body?.liveSessions ?? []) as Array<{
          id?: unknown;
          tmuxName?: unknown;
          tmuxId?: unknown;
        }>;
        const ready = sessions.find((session) => (
          typeof session.id === 'string'
          && !session.id.startsWith('idle-gjc:')
          && session.tmuxName === externalTerminal.tmuxName
          && (externalTerminal.tmuxId === null || session.tmuxId === externalTerminal.tmuxId)
        ));
        if (!ready || typeof ready.id !== 'string') return;

        resolving = true;
        const detailsResponse = await api.sessionDetails(ready.id);
        const detailsBody = await detailsResponse.json().catch(() => null);
        const session = detailsBody?.data?.session as {
          sessionId?: unknown;
          provider?: unknown;
          summary?: unknown;
          projectId?: unknown;
          createdAt?: unknown;
          updatedAt?: unknown;
        } | undefined;
        const projectId = typeof session?.projectId === 'string' ? session.projectId : '';
        const project = sidebarSharedProps.projects.find((candidate) => candidate.projectId === projectId);
        if (
          cancelled
          || !detailsResponse.ok
          || session?.sessionId !== ready.id
          || session.provider !== 'gjc'
          || !project
        ) {
          resolving = false;
          return;
        }

        setExternalTerminal(null);
        setExternalTranscript(null);
        setActiveTab('chat');
        sidebarSharedProps.onProjectSelect(project);
        sidebarSharedProps.onSessionSelect({
          id: ready.id,
          summary: typeof session.summary === 'string' ? session.summary : '',
          createdAt: typeof session.createdAt === 'string' ? session.createdAt : undefined,
          updated_at: typeof session.updatedAt === 'string' ? session.updatedAt : undefined,
          __provider: 'gjc',
          __projectId: project.projectId,
        });
      } catch {
        resolving = false;
        // Best-effort: the next poll retries transcript discovery/indexing.
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [externalTerminal, setActiveTab, sidebarSharedProps]);

  // Wrap navigation-ish sidebar handlers so leaving for a session/project/new
  // chat drops the terminal takeover — without modifying the originals.
  const sidebarProps = useMemo(() => ({
    ...sidebarSharedProps,
    onProjectSelect: (...args: Parameters<typeof sidebarSharedProps.onProjectSelect>) => {
      setExternalTerminal(null);
      setExternalTranscript(null);
      return sidebarSharedProps.onProjectSelect(...args);
    },
    onSessionSelect: (...args: Parameters<typeof sidebarSharedProps.onSessionSelect>) => {
      setExternalTerminal(null);
      setExternalTranscript(null);
      return sidebarSharedProps.onSessionSelect(...args);
    },
    onNewSession: (...args: Parameters<typeof sidebarSharedProps.onNewSession>) => {
      setExternalTerminal(null);
      setExternalTranscript(null);
      return sidebarSharedProps.onNewSession(...args);
    },
    onExternalTerminalOpen: openExternalTerminal,
  }), [sidebarSharedProps, openExternalTerminal]);

  const activeExternalTranscript = externalTranscript
    && externalTranscript.cliKind !== 'ssh'
    && externalTranscript.cliKind !== 'gjc'
    && externalTranscript.transcriptSessionId === sessionId
    ? externalTranscript
    : null;

  // Queued messages for sessions that finish while another session (or none)
  // is being viewed are sent from here; the viewed session's composer handles
  // its own queue.
  useQueuedMessageAutoSend({
    processingSessions,
    activeSessionId: selectedSession?.id ?? sessionId ?? null,
    // tmux-owned sessions must never receive an invisible background send.
    liveSessionIds: sidebarSharedProps.liveSessionIds,
    ws,
    sendMessage,
    markSessionProcessing,
  });

  const refreshRunningSessions = useCallback(async () => {
    try {
      const response = await api.runningSessions();
      if (!response.ok) {
        return;
      }

      const payload = (await response.json()) as RunningSessionsApiPayload;
      const sessions = Array.isArray(payload.data?.sessions) ? payload.data.sessions : [];

      syncProcessingSessions(
        sessions
          .map((session) => {
            if (typeof session.sessionId !== 'string' || !session.sessionId) {
              return null;
            }

            return {
              sessionId: session.sessionId,
              startedAt: parseStartedAt(session.startedAt),
              statusText: typeof session.statusText === 'string' ? session.statusText : undefined,
              canInterrupt: typeof session.canInterrupt === 'boolean' ? session.canInterrupt : undefined,
            };
          })
          .filter((session): session is NonNullable<typeof session> => Boolean(session)),
      );
    } catch (error) {
      console.error('[AppContent] Failed to sync running sessions:', error);
    }
  }, [syncProcessingSessions]);

  useEffect(() => {
    void refreshRunningSessions();
  }, [refreshRunningSessions]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      void refreshRunningSessions();
    }, 5000);

    return () => window.clearInterval(interval);
  }, [refreshRunningSessions]);

  usePaletteOpsRegister({
    openSettings,
    refreshProjects: refreshProjectsSilently,
  });

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

      setExternalTerminal(null);
      setActiveTab('chat');
      setSidebarOpen(false);
      void refreshProjectsSilently();

      if (typeof message.sessionId === 'string' && message.sessionId) {
        navigate(`/session/${message.sessionId}`);
        return;
      }

      navigate('/');
    };

    navigator.serviceWorker.addEventListener('message', handleServiceWorkerMessage);

    return () => {
      navigator.serviceWorker.removeEventListener('message', handleServiceWorkerMessage);
    };
  }, [navigate, refreshProjectsSilently, setActiveTab, setSidebarOpen]);

  // Pending tool permissions are recovered through the `chat.subscribe` flow:
  // the `chat_subscribed` ack carries them on session open and on reconnect,
  // so no separate permission-recovery message is needed here.

  // Adjust the app container to stay above the virtual keyboard on iOS Safari.
  // On Chrome for Android the layout viewport already shrinks when the keyboard opens,
  // so inset-0 adjusts automatically. On iOS the layout viewport stays full-height and
  // the keyboard overlays it — we use the Visual Viewport API to track keyboard height
  // and apply it as a CSS variable that shifts the container's bottom edge up.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      // Only resize matters — keyboard open/close changes vv.height.
      // Do NOT listen to scroll: on iOS Safari, scrolling content changes
      // vv.offsetTop which would make --keyboard-height fluctuate during
      // normal scrolling, causing the container to bounce up and down.
      const kb = Math.max(0, window.innerHeight - vv.height);
      document.documentElement.style.setProperty('--keyboard-height', `${kb}px`);
    };
    vv.addEventListener('resize', update);
    return () => vv.removeEventListener('resize', update);
  }, []);

  return (
    <div className="fixed inset-0 flex bg-background" style={{ bottom: 'var(--keyboard-height, 0px)' }}>
      {!isMobile ? (
        <div className="h-full flex-shrink-0 border-r border-border/50">
          <Sidebar {...sidebarProps} />
        </div>
      ) : (
        <div
          className={`fixed inset-0 z-50 flex transition-all duration-150 ease-out ${sidebarOpen ? 'visible opacity-100' : 'invisible opacity-0'
            }`}
        >
          <button
            className="fixed inset-0 bg-background/60 backdrop-blur-sm transition-opacity duration-150 ease-out"
            onClick={(event) => {
              event.stopPropagation();
              setSidebarOpen(false);
            }}
            onTouchStart={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setSidebarOpen(false);
            }}
            aria-label={t('versionUpdate.ariaLabels.closeSidebar')}
          />
          <div
            className={`relative h-full w-[85vw] max-w-sm transform border-r border-border/40 bg-card transition-transform duration-150 ease-out sm:w-80 ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'
              }`}
            onClick={(event) => event.stopPropagation()}
            onTouchStart={(event) => event.stopPropagation()}
          >
            <Sidebar {...sidebarProps} />
          </div>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <MainContent
          selectedProject={selectedProject}
          selectedSession={selectedSession}
          isSessionReadOnly={Boolean(
            selectedSession
            && (sidebarSharedProps.liveSessionIds.has(selectedSession.id) || activeExternalTranscript),
          )}
          liveSessionTmuxName={
            // Relay (tower /send types into the tmux pane) only for LINEAGE
            // claims — a cwd-fallback label points at someone else's pane.
            selectedSession && sidebarSharedProps.liveSessionLineage.has(selectedSession.id)
              ? (sidebarSharedProps.liveSessionNames.get(selectedSession.id) ?? null)
              : activeExternalTranscript?.tmuxName ?? null
          }
          liveSessionTmuxId={
            selectedSession && sidebarSharedProps.liveSessionLineage.has(selectedSession.id)
              ? (sidebarSharedProps.liveSessionTmuxIds.get(selectedSession.id) ?? null)
              : null
          }
          liveSessionModel={activeExternalTranscript?.model
            ?? (selectedSession ? (liveSessionModels.get(selectedSession.id) ?? null) : null)}
          liveSessionKind={activeExternalTranscript
            ? activeExternalTranscript.cliKind as Exclude<ExternalTerminalTarget['cliKind'], 'ssh'>
            : selectedSession && sidebarSharedProps.liveSessionLineage.has(selectedSession.id)
              ? 'gjc'
              : null}
          activeTab={activeTab}
          setActiveTab={setActiveTab}
          ws={ws}
          sendMessage={sendMessage}
          isMobile={isMobile}
          onMenuClick={() => setSidebarOpen(true)}
          isLoading={isLoadingProjects}
          onInputFocusChange={setIsInputFocused}
          onSessionProcessing={markSessionProcessing}
          onSessionIdle={markSessionIdle}
          processingSessions={processingSessions}
          onNavigateToSession={(targetSessionId: string, options) =>
            navigate(`/session/${targetSessionId}`, { replace: Boolean(options?.replace) })
          }
          onSessionEstablished={(targetSessionId, context) =>
            registerOptimisticSession({ sessionId: targetSessionId, ...context })
          }
          onShowSettings={openSettings}
          externalMessageUpdate={externalMessageUpdate}
          newSessionTrigger={newSessionTrigger}
          externalTranscript={activeExternalTranscript}
          externalTerminal={externalTerminal}
          onExternalTerminalClose={closeExternalTerminal}
        />
      </div>

      <CommandPalette
        selectedProject={selectedProject}
        onStartNewChat={(...args: Parameters<typeof handleNewSession>) => {
          setExternalTerminal(null);
          return handleNewSession(...args);
        }}
        onOpenSettings={() => openSettings()}
        onShowTab={(tab: Parameters<typeof setActiveTab>[0]) => {
          setExternalTerminal(null);
          setActiveTab(tab);
        }}
      />
    </div>
  );
}
