import { useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import Sidebar from '../sidebar/view/Sidebar';
import MainContent from '../main-content/view/MainContent';
import CommandPalette from '../command-palette/CommandPalette';
import { useWebSocket } from '../../contexts/WebSocketContext';
import { PaletteOpsProvider, usePaletteOpsRegister } from '../../contexts/PaletteOpsContext';
import { useDeviceSettings } from '../../hooks/useDeviceSettings';
import { useProjectsState } from '../../hooks/useProjectsState';
import { useFleetHost } from '../../fleet/FleetSessionRoute';
import { useFleetHostCatalog } from '../../fleet/discovery/FleetHostCatalogContext';
import type { ExternalTerminalTarget } from '../../types/app';

import { useRunningSessionsSync } from './hooks/useRunningSessionsSync';
import { useActiveExternalTranscript } from './hooks/useActiveExternalTranscript';
import { useExternalTerminalState } from './hooks/useExternalTerminalState';
import { useNotificationNavigation } from './hooks/useNotificationNavigation';
import { useKeyboardViewportInset } from './hooks/useKeyboardViewportInset';
import { useQueuedDraftAutoSend } from './hooks/useQueuedDraftAutoSend';
import { useSessionProcessingWiring } from './hooks/useSessionProcessingWiring';
import { remoteRouteSelection } from './remoteRouteSelection';

// Re-exported for stable imports; implementations live in the extracted modules.
export { isSameExternalTerminal, refreshExternalTerminalAttachCapability, resolveExternalTerminalRoute } from './externalTerminalRouting';
export { useExternalTerminalDiscoveryAuthority } from './useExternalTerminalDiscoveryAuthority';


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

  const fleetHost = useFleetHost();
  const {
    qualifiedProcessingSessions,
    processingSessions,
    localProcessingSessions,
    markSessionProcessing,
    markSessionIdle,
    markProcessing,
    syncProcessing,
    sessionPathFor,
    localHostId,
    viewedHostId,
  } = useSessionProcessingWiring(fleetHost);

  const {
    selectedProject: localSelectedProject,
    selectedSession: localSelectedSession,
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
    activeSessions: localProcessingSessions,
  });
  const { catalog } = useFleetHostCatalog();
  const remoteSelection = useMemo(
    () => remoteRouteSelection(catalog, fleetHost.activeSession),
    [catalog, fleetHost.activeSession],
  );
  const selectedProject = remoteSelection?.project ?? localSelectedProject;
  const selectedSession = remoteSelection?.session ?? localSelectedSession;

  const {
    externalTerminal,
    setExternalTerminal,
    externalTranscript,
    setExternalTranscript,
    externalRunningPanes,
    refreshExternalTerminalCapability,
    openExternalTerminal,
    closeExternalTerminal,
  } = useExternalTerminalState({
    setActiveTab,
    setSidebarOpen,
    onProjectSelect: sidebarSharedProps.onProjectSelect,
    onSessionSelect: sidebarSharedProps.onSessionSelect,
    projects: sidebarSharedProps.projects,
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
    onRemoteTranscriptOpen: () => {
      closeExternalTerminal();
      setActiveTab('chat');
      setSidebarOpen(false);
    },
    onExternalSessionsChange: refreshExternalTerminalCapability,
  }), [
    sidebarSharedProps,
    closeExternalTerminal,
    openExternalTerminal,
    refreshExternalTerminalCapability,
    setActiveTab,
    setExternalTerminal,
    setExternalTranscript,
    setSidebarOpen,
  ]);

  const { activeExternalTranscript, liveSessionTarget, liveSessionProcessing } = useActiveExternalTranscript({
    externalTranscript,
    sessionId,
    selectedSession,
    externalRunningPanes,
    liveSessionLineage: sidebarSharedProps.liveSessionLineage,
    liveSessionTargets: sidebarSharedProps.liveSessionTargets,
    liveSessionRunning: sidebarSharedProps.liveSessionRunning,
  });

  useQueuedDraftAutoSend({
    qualifiedProcessingSessions,
    activeSessionKey: fleetHost.activeSessionKey,
    liveSessionIds: sidebarSharedProps.liveSessionIds,
    localHostId,
    ws,
    sendMessage,
    markProcessing,
  });
  useRunningSessionsSync(localHostId, syncProcessing);

  usePaletteOpsRegister({
    openSettings,
    refreshProjects: refreshProjectsSilently,
  });
  useNotificationNavigation({
    navigate,
    sessionPathFor,
    refreshProjectsSilently,
    setActiveTab,
    setSidebarOpen,
    clearExternalTerminal: () => setExternalTerminal(null),
  });
  useKeyboardViewportInset();

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
            && (sidebarSharedProps.liveSessionIds.has(selectedSession.id) || activeExternalTranscript || (liveSessionTarget && 'hostId' in liveSessionTarget)),
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
            navigate(sessionPathFor(viewedHostId, targetSessionId), { replace: Boolean(options?.replace) })
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
