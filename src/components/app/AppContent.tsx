import { useCallback, useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import Sidebar from '../sidebar/view/Sidebar';
import MainContent from '../main-content/view/MainContent';
import CommandPalette from '../command-palette/CommandPalette';
import { useWebSocket, type ServerEvent } from '../../contexts/WebSocketContext';
import { PaletteOpsProvider, usePaletteOpsRegister } from '../../contexts/PaletteOpsContext';
import { useDeviceSettings } from '../../hooks/useDeviceSettings';
import { useSessionProtection } from '../../hooks/useSessionProtection';
import { useProjectsState } from '../../hooks/useProjectsState';
import { useQueuedMessageAutoSend } from '../../hooks/useQueuedMessageAutoSend';
import { api } from '../../utils/api';
import {
  findGjcPromotionCandidate,
  hasGjcTerminalTarget,
  readRestSessionContainer,
} from '../../utils/liveSessions';
import type { ExternalTerminalTarget, Project, ProjectSession } from '../../types/app';
import type { ExternalCliSession } from '../sidebar/hooks/useExternalCliSessions';
import { tmuxPaneIdentityKey } from '../../../shared/tmux';

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

export const isSameExternalTerminal = (
  current: ExternalTerminalTarget | null,
  expected: ExternalTerminalTarget,
): boolean => Boolean(
  current
  && current.cliKind === expected.cliKind
  && current.tmux.socketPath === expected.tmux.socketPath
  && current.tmux.sessionId === expected.tmux.sessionId
  && current.tmux.windowId === expected.tmux.windowId
  && current.tmux.paneId === expected.tmux.paneId
  && (
    current.process === null && expected.process === null
    || current.process !== null
      && expected.process !== null
      && current.process.pid === expected.process.pid
      && current.process.startedAtMs === expected.process.startedAtMs
  ),
);
export function refreshExternalTerminalAttachCapability(
  target: ExternalTerminalTarget | null,
  sessions: readonly ExternalCliSession[],
): ExternalTerminalTarget | null {
  if (!target || target.cliKind === 'gjc') {
    return target;
  }

  const session = sessions.find((candidate) => (
    candidate.authority !== 'none'
    && candidate.presence !== 'stale'
    && candidate.kind === target.cliKind
    && candidate.tmux.socketPath === target.tmux.socketPath
    && candidate.tmux.sessionId === target.tmux.sessionId
    && candidate.tmux.windowId === target.tmux.windowId
    && candidate.tmux.paneId === target.tmux.paneId
  ));
  if (!session) {
    return null;
  }

  if (target.cliKind === 'ssh' || target.cliKind === 'shell') {
    return session.attachCapability
      ? { ...target, attachCapability: session.attachCapability }
      : null;
  }

  return session.process
    && target.process
    && session.process.pid === target.process.pid
    && session.process.startedAtMs === target.process.startedAtMs
    ? {
        ...target,
        process: session.process,
        projectPath: session.projectPath ?? target.projectPath,
        transcriptSessionId: session.transcriptSessionId,
        sessionName: session.sessionName ?? target.sessionName,
        model: session.model ?? target.model,
        effort: session.effort ?? target.effort,
      }
    : null;
}
export function resolveExternalTerminalRoute(
  target: ExternalTerminalTarget,
): 'transcript' | 'terminal' {
  // B8: a forced attach always wins — it exists specifically so the
  // asking_user badge can bypass the structured transcript and land the
  // user on the exact pane's terminal, even once that pane is indexed.
  if (target.forceAttach) {
    return 'terminal';
  }
  if (
    target.cliKind !== 'gjc'
    && target.cliKind !== 'ssh'
    && target.cliKind !== 'shell'
    && target.transcriptSessionId
    && target.project
  ) {
    return 'transcript';
  }
  return 'terminal';
}

type DiscoveryAuthorityOptions = {
  externalTerminal: ExternalTerminalTarget | null;
  setExternalTerminal: Dispatch<SetStateAction<ExternalTerminalTarget | null>>;
  setExternalTranscript: Dispatch<SetStateAction<ExternalTerminalTarget | null>>;
  openExternalTerminal: (target: ExternalTerminalTarget) => void;
  setActiveTab: (tab: 'chat') => void;
  sidebarSharedProps: {
    projects: readonly Project[];
    onProjectSelect: (project: Project) => unknown;
    onSessionSelect: (session: ProjectSession) => unknown;
  };
  subscribe: (listener: (event: ServerEvent) => void) => () => void;
};

export function useExternalTerminalDiscoveryAuthority({
  externalTerminal,
  setExternalTerminal,
  setExternalTranscript,
  openExternalTerminal,
  setActiveTab,
  sidebarSharedProps,
  subscribe,
}: DiscoveryAuthorityOptions): void {
  useEffect(() => {
    if (
      !externalTerminal
      || externalTerminal.cliKind === 'gjc'
      || externalTerminal.cliKind === 'ssh'
      || externalTerminal.cliKind === 'shell'
      || externalTerminal.transcriptSessionId
      || externalTerminal.forceAttach
    ) return undefined;
    const target = externalTerminal;
    let cancelled = false;
    let requestGeneration = 0;
    let appliedGeneration = 0;
    let activeController: AbortController | null = null;
    const invalidateTarget = () => {
      setExternalTerminal((current) => (
        isSameExternalTerminal(current, target) ? null : current
      ));
    };
    const poll = async () => {
      const generation = ++requestGeneration;
      activeController?.abort();
      const controller = new AbortController();
      activeController = controller;
      try {
        const response = await api.externalSessions(controller.signal);
        if (
          cancelled
          || controller.signal.aborted
          || generation !== requestGeneration
          || generation <= appliedGeneration
        ) return;
        if (!response.ok) {
          appliedGeneration = generation;
          invalidateTarget();
          return;
        }

        const body = await response.json();
        if (
          cancelled
          || controller.signal.aborted
          || generation !== requestGeneration
          || generation <= appliedGeneration
        ) return;
        appliedGeneration = generation;
        const container = readRestSessionContainer(body, 'externalSessions');
        if (!container?.discoveryOk) {
          invalidateTarget();
          return;
        }
        const sessions = container.sessions as ExternalCliSession[];

        const refreshed = refreshExternalTerminalAttachCapability(target, sessions);
        if (!refreshed) {
          invalidateTarget();
          return;
        }
        if ('transcriptSessionId' in refreshed && refreshed.transcriptSessionId) {
          openExternalTerminal(refreshed);
        }
      } catch {
        if (
          !cancelled
          && !controller.signal.aborted
          && generation === requestGeneration
          && generation > appliedGeneration
        ) {
          appliedGeneration = generation;
          invalidateTarget();
        }
      }
    };
    void poll();
    const unsubscribe = subscribe((event) => {
      if (event.kind === 'discovery.snapshot' || event.kind === 'discovery.delta') void poll();
    });
    return () => {
      cancelled = true;
      activeController?.abort();
      unsubscribe();
    };
  }, [externalTerminal, openExternalTerminal, setExternalTerminal, subscribe]);

  useEffect(() => {
    if (externalTerminal?.cliKind !== 'gjc') return undefined;
    const target = externalTerminal;
    let cancelled = false;
    let requestGeneration = 0;
    let appliedGeneration = 0;
    let activeController: AbortController | null = null;
    const invalidateTarget = () => {
      setExternalTerminal((current) => (
        isSameExternalTerminal(current, target) ? null : current
      ));
    };
    const poll = async () => {
      const generation = ++requestGeneration;
      activeController?.abort();
      const controller = new AbortController();
      activeController = controller;
      try {
        const response = await api.liveSessions(controller.signal);
        if (
          cancelled
          || controller.signal.aborted
          || generation !== requestGeneration
          || generation <= appliedGeneration
        ) return;
        if (!response.ok) {
          appliedGeneration = generation;
          invalidateTarget();
          return;
        }

        const body = await response.json();
        if (
          cancelled
          || controller.signal.aborted
          || generation !== requestGeneration
          || generation <= appliedGeneration
        ) return;
        appliedGeneration = generation;
        const container = readRestSessionContainer(body, 'liveSessions');
        if (!container?.discoveryOk) {
          invalidateTarget();
          return;
        }
        const sessions = container.sessions as Parameters<typeof hasGjcTerminalTarget>[0];
        if (!hasGjcTerminalTarget(sessions, target)) {
          invalidateTarget();
          return;
        }

        const ready = findGjcPromotionCandidate(sessions, target);
        if (!ready) return;

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
          || controller.signal.aborted
          || generation !== requestGeneration
          || generation !== appliedGeneration
          || !detailsResponse.ok
          || session?.sessionId !== ready.id
          || session.provider !== 'gjc'
          || !project
        ) return;

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
        if (
          !cancelled
          && !controller.signal.aborted
          && generation === requestGeneration
          && generation > appliedGeneration
        ) {
          appliedGeneration = generation;
          invalidateTarget();
        }
      }
    };
    void poll();
    const unsubscribe = subscribe((event) => {
      if (event.kind === 'discovery.snapshot' || event.kind === 'discovery.delta') void poll();
    });
    return () => {
      cancelled = true;
      activeController?.abort();
      unsubscribe();
    };
  }, [externalTerminal, setActiveTab, setExternalTerminal, setExternalTranscript, sidebarSharedProps, subscribe]);
}

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
  const { ws, isConnected, sendMessage, subscribe } = useWebSocket();

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
    liveSessionEfforts,
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
    isConnected,
    sendMessage,
    isMobile,
    activeSessions: processingSessions,
  });

  // Local coding-agent targets switch to structured transcripts when indexed;
  // terminal attach is the fallback before indexing and the only view for SSH/shell.
  const [externalTerminal, setExternalTerminal] = useState<ExternalTerminalTarget | null>(null);
  const [externalTranscript, setExternalTranscript] = useState<ExternalTerminalTarget | null>(null);
  const selectExternalProject = sidebarSharedProps.onProjectSelect;
  const selectExternalSession = sidebarSharedProps.onSessionSelect;
  // Pane keys of external sessions currently running a turn. Fed by the same
  // sidebar-published roster as attach capability; no extra request is added.
  const [externalRunningPanes, setExternalRunningPanes] = useState<ReadonlySet<string>>(new Set());
  const refreshExternalTerminalCapability = useCallback((sessions: ExternalCliSession[]) => {
    setExternalTerminal((current) => refreshExternalTerminalAttachCapability(current, sessions));
    setExternalRunningPanes((current) => {
      const next = new Set(sessions
        .filter((session) => session.activity === 'running')
        .map((session) => tmuxPaneIdentityKey(session.tmux)));
      if (next.size === current.size && [...next].every((key) => current.has(key))) return current;
      return next;
    });
  }, []);

  const openExternalTerminal = useCallback((
    target: ExternalTerminalTarget,
    options?: { forceAttach?: boolean },
  ) => {
    // The approval-pending badge asks for the interactive pane rather than the
    // indexed transcript, so fold its request into the target before routing.
    const routed: ExternalTerminalTarget = options?.forceAttach ? { ...target, forceAttach: true } : target;
    if (
      routed.cliKind !== 'gjc'
      && routed.cliKind !== 'ssh'
      && routed.cliKind !== 'shell'
      && routed.transcriptSessionId
      && routed.project
      && resolveExternalTerminalRoute(routed) === 'transcript'
    ) {
      setExternalTerminal(null);
      setExternalTranscript(routed);
      setActiveTab('chat');
      selectExternalProject(routed.project);
      selectExternalSession({
        id: routed.transcriptSessionId,
        summary: routed.sessionName ?? '',
        __provider: routed.cliKind,
        __projectId: routed.project.projectId,
      });
      setSidebarOpen(false);
      return;
    }
    setExternalTranscript(null);
    setExternalTerminal(routed);
    setSidebarOpen(false);
  }, [selectExternalProject, selectExternalSession, setActiveTab, setSidebarOpen]);

  const closeExternalTerminal = useCallback(() => {
    setExternalTerminal(null);
  }, []);

  useExternalTerminalDiscoveryAuthority({
    externalTerminal,
    setExternalTerminal,
    setExternalTranscript,
    openExternalTerminal,
    setActiveTab,
    sidebarSharedProps,
    subscribe,
  });

  // Wrap sidebar navigation so leaving for a project or session drops the
  // terminal takeover without modifying the original handlers.
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
    onExternalTerminalOpen: openExternalTerminal,
    onExternalSessionsChange: refreshExternalTerminalCapability,
  }), [sidebarSharedProps, openExternalTerminal, refreshExternalTerminalCapability]);

  const activeExternalTranscript = externalTranscript
    && externalTranscript.cliKind !== 'ssh'
    && externalTranscript.cliKind !== 'shell'
    && externalTranscript.cliKind !== 'gjc'
    && externalTranscript.transcriptSessionId === sessionId
    ? externalTranscript
    : null;

  // Relay only for exact pane and process generations. A cwd-only label may
  // point at another pane and is never actionable. Memoized: an inline object
  // literal here changes identity every render, which tears down MainContent's
  // pane-output polling effect and blanks the CLI output view (visible flicker).
  const liveSessionTarget = useMemo(() => (
    selectedSession && sidebarSharedProps.liveSessionLineage.has(selectedSession.id)
      ? (sidebarSharedProps.liveSessionTargets.get(selectedSession.id) ?? null)
      : activeExternalTranscript?.process
        ? { tmux: activeExternalTranscript.tmux, process: activeExternalTranscript.process }
        : null
  ), [
    selectedSession,
    sidebarSharedProps.liveSessionLineage,
    sidebarSharedProps.liveSessionTargets,
    activeExternalTranscript,
  ]);

  // Drives the relay composer's send↔stop control for the viewed session.
  const liveSessionProcessing = activeExternalTranscript
    ? externalRunningPanes.has(tmuxPaneIdentityKey(activeExternalTranscript.tmux))
    : selectedSession
      ? sidebarSharedProps.liveSessionRunning.has(selectedSession.id)
      : false;

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
    <div className="app-shell fixed inset-0 flex bg-background" style={{ bottom: 'var(--keyboard-height, 0px)' }}>
      <div aria-hidden="true" className="pwa-status-bar-surface" />
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
          liveSessionTarget={liveSessionTarget}
          liveSessionModel={activeExternalTranscript?.model
            ?? (selectedSession ? (liveSessionModels.get(selectedSession.id) ?? null) : null)}
          liveSessionEffort={activeExternalTranscript?.effort
            ?? (selectedSession ? (liveSessionEfforts.get(selectedSession.id) ?? null) : null)}
          liveSessionName={activeExternalTranscript?.tmuxName
            ?? (selectedSession ? (sidebarSharedProps.liveSessionNames.get(selectedSession.id) ?? null) : null)}
          liveSessionKind={activeExternalTranscript
            ? activeExternalTranscript.cliKind as Exclude<ExternalTerminalTarget['cliKind'], 'ssh' | 'shell'>
            : selectedSession && sidebarSharedProps.liveSessionLineage.has(selectedSession.id)
              ? 'gjc'
              : null}
          liveSessionProcessing={liveSessionProcessing}
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
