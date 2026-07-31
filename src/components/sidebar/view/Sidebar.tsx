import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useDeviceSettings } from '../../../hooks/useDeviceSettings';
import { useVersionCheck } from '../../../hooks/useVersionCheck';
import { useUiPreferences } from '../../../hooks/useUiPreferences';
import type { SidebarProps } from '../types/types';

import SidebarCollapsed from './subcomponents/SidebarCollapsed';
import SidebarContent from './subcomponents/SidebarContent';
import SidebarModals from './subcomponents/SidebarModals';
const EMPTY_SESSION_IDS = new Set<string>();
const EMPTY_CONNECTION_ISSUES = new Map();

function Sidebar({
  projects,
  selectedSession,
  liveSessionIds,
  liveSessionNames,
  liveSessionModels,
  liveSessionEfforts,
  liveSessionLineage,
  liveSessionPanes,
  liveSessionPresence,
  liveSessionTargets,
  liveSessionKinds,
  liveSessionRunning,
  liveSessionInput = EMPTY_SESSION_IDS,
  liveSessionErrors = EMPTY_SESSION_IDS,
  liveSessionConnectionIssues = EMPTY_CONNECTION_ISSUES,
  liveSessionsLoaded,
  onProjectSelect,
  onSessionSelect,
  onRefresh,
  onShowSettings,
  showSettings,
  settingsInitialTab,
  onCloseSettings,
  isMobile,
  onExternalTerminalOpen,
  onExternalSessionsChange,
}: SidebarProps) {
  const { t } = useTranslation(['sidebar', 'common']);
  const { isPWA } = useDeviceSettings({ trackMobile: false });
  const {
    activeJob,
    bootId,
    canUpdate,
    clientRefreshAvailable,
    installMode,
    latestVersion,
    currentVersion,
    runningVersion,
    serverUpdateAvailable,
    sourceUpdate,
    sourceUpdateInFlight,
  } = useVersionCheck(
    'devswha',
    'chatmux',
  );
  const { preferences, setPreference } = useUiPreferences();
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showVersionModal, setShowVersionModal] = useState(false);

  useEffect(() => {
    if (typeof document === 'undefined') {
      return;
    }

    document.documentElement.classList.toggle('pwa-mode', isPWA);
    document.body.classList.toggle('pwa-mode', isPWA);
  }, [isPWA]);

  const refresh = useCallback(async () => {
    if (isRefreshing) {
      return;
    }

    setIsRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setIsRefreshing(false);
    }
  }, [isRefreshing, onRefresh]);

  const collapseSidebar = useCallback(() => {
    setPreference('sidebarVisible', false);
  }, [setPreference]);

  const expandSidebar = useCallback(() => {
    setPreference('sidebarVisible', true);
  }, [setPreference]);

  return (
    <>
      <SidebarModals
        projects={projects}
        showSettings={showSettings}
        settingsInitialTab={settingsInitialTab}
        onCloseSettings={onCloseSettings}
        showVersionModal={showVersionModal}
        onCloseVersionModal={() => setShowVersionModal(false)}
        currentVersion={currentVersion}
        runningVersion={runningVersion}
        latestVersion={latestVersion}
        installMode={installMode}
        clientRefreshAvailable={clientRefreshAvailable}
        serverUpdateAvailable={serverUpdateAvailable}
        canUpdate={canUpdate}
        bootId={bootId}
        activeJob={activeJob}
        sourceUpdateInFlight={sourceUpdateInFlight}
        sourceUpdate={sourceUpdate}
      />

      {!preferences.sidebarVisible ? (
        <SidebarCollapsed
          onExpand={expandSidebar}
          onShowSettings={onShowSettings}
          clientRefreshAvailable={clientRefreshAvailable}
          serverUpdateAvailable={serverUpdateAvailable}
          onShowVersionModal={() => setShowVersionModal(true)}
          t={t}
        />
      ) : (
        <SidebarContent
          isPWA={isPWA}
          isMobile={isMobile}
          projects={projects}
          selectedSession={selectedSession}
          liveSessionIds={liveSessionIds}
          liveSessionNames={liveSessionNames}
          liveSessionModels={liveSessionModels}
          liveSessionEfforts={liveSessionEfforts}
          liveSessionLineage={liveSessionLineage}
          liveSessionPanes={liveSessionPanes}
          liveSessionPresence={liveSessionPresence}
          liveSessionTargets={liveSessionTargets}
          liveSessionKinds={liveSessionKinds}
          liveSessionRunning={liveSessionRunning}
          liveSessionInput={liveSessionInput}
          liveSessionErrors={liveSessionErrors}
          liveSessionConnectionIssues={liveSessionConnectionIssues}
          liveSessionsLoaded={liveSessionsLoaded}
          onProjectSelect={onProjectSelect}
          onSessionSelect={onSessionSelect}
          onRefresh={() => {
            void refresh();
          }}
          isRefreshing={isRefreshing}
          onCollapseSidebar={collapseSidebar}
          clientRefreshAvailable={clientRefreshAvailable}
          serverUpdateAvailable={serverUpdateAvailable}
          installMode={installMode}
          latestVersion={latestVersion}
          currentVersion={currentVersion}
          onShowVersionModal={() => setShowVersionModal(true)}
          onShowSettings={onShowSettings}
          onExternalTerminalOpen={onExternalTerminalOpen}
          onExternalSessionsChange={onExternalSessionsChange}
          t={t}
        />
      )}
    </>
  );
}

export default Sidebar;
