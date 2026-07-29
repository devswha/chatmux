import type { TFunction } from 'i18next';

import { ScrollArea } from '../../../../shared/view/ui';
import type { ExternalTerminalTarget, Project, ProjectSession } from '../../../../types/app';
import type { TmuxPaneTarget } from '../../../../../shared/tmux';
import { useExternalCliSessions, type ExternalCliSession } from '../../hooks/useExternalCliSessions';

import SidebarFooter from './SidebarFooter';
import SidebarHeader from './SidebarHeader';
import SidebarLiveSection from './SidebarLiveSection';
import SidebarExternalSection from './SidebarExternalSection';
import SidebarNewSession from './SidebarNewSession';

type SidebarContentProps = {
  isPWA: boolean;
  isMobile: boolean;
  projects: Project[];
  selectedSession: ProjectSession | null;
  liveSessionIds: ReadonlySet<string>;
  liveSessionNames: ReadonlyMap<string, string>;
  liveSessionModels: ReadonlyMap<string, string>;
  liveSessionEfforts: ReadonlyMap<string, string>;
  liveSessionLineage: ReadonlySet<string>;
  liveSessionTargets: ReadonlyMap<string, TmuxPaneTarget>;
  liveSessionKinds: ReadonlyMap<string, string>;
  liveSessionRunning: ReadonlySet<string>;
  liveSessionsLoaded: boolean;
  onProjectSelect: (project: Project) => void;
  onSessionSelect: (session: ProjectSession, projectId?: string) => void;
  onRefresh: () => void;
  isRefreshing: boolean;
  onCollapseSidebar: () => void;
  clientRefreshAvailable: boolean;
  serverUpdateAvailable: boolean;
  latestVersion: string | null;
  currentVersion: string;
  onShowVersionModal: () => void;
  onShowSettings: () => void;
  onExternalTerminalOpen: (target: ExternalTerminalTarget, options?: { forceAttach?: boolean }) => void;
  onExternalSessionsChange: (sessions: ExternalCliSession[]) => void;
  t: TFunction;
};

export default function SidebarContent({
  isPWA,
  isMobile,
  projects,
  selectedSession,
  liveSessionIds,
  liveSessionNames,
  liveSessionModels,
  liveSessionEfforts,
  liveSessionLineage,
  liveSessionTargets,
  liveSessionKinds,
  liveSessionRunning,
  liveSessionsLoaded,
  onProjectSelect,
  onSessionSelect,
  onRefresh,
  isRefreshing,
  onCollapseSidebar,
  clientRefreshAvailable,
  serverUpdateAvailable,
  latestVersion,
  currentVersion,
  onShowVersionModal,
  onShowSettings,
  onExternalTerminalOpen,
  onExternalSessionsChange,
  t,
}: SidebarContentProps) {
  const { sessions: externalSessions, loading: externalLoading, refresh: refreshDiscoveredSessions } = useExternalCliSessions(onExternalSessionsChange);
  // The hook's refresh sends a unified discovery resync, updating both live and external rows.
  const sessionCount = liveSessionIds.size + externalSessions.length;
  const refreshAllSessions = () => {
    refreshDiscoveredSessions();
    onRefresh();
  };

  return (
    <div className="flex h-full flex-col bg-background/80 backdrop-blur-sm md:w-72 md:select-none">
      <SidebarHeader
        isPWA={isPWA}
        isMobile={isMobile}
        onRefresh={refreshAllSessions}
        isRefreshing={isRefreshing}
        onCollapseSidebar={onCollapseSidebar}
        t={t}
      />

      <ScrollArea className="flex-1 overflow-y-auto overscroll-contain md:px-1.5 md:py-2">
        <SidebarNewSession onCreated={refreshDiscoveredSessions} />
        {sessionCount > 0 ? (
          <>
            <SidebarLiveSection
              projects={projects}
              liveSessionIds={liveSessionIds}
              selectedSession={selectedSession}
              onProjectSelect={onProjectSelect}
              onSessionSelect={onSessionSelect}
              liveSessionNames={liveSessionNames}
              liveSessionModels={liveSessionModels}
              liveSessionEfforts={liveSessionEfforts}
              liveSessionLineage={liveSessionLineage}
              liveSessionTargets={liveSessionTargets}
              liveSessionKinds={liveSessionKinds}
              liveSessionRunning={liveSessionRunning}
              onExternalTerminalOpen={onExternalTerminalOpen}
            />
            <SidebarExternalSection
              sessions={externalSessions}
              projects={projects}
              onOpen={onExternalTerminalOpen}
              onChanged={refreshDiscoveredSessions}
            />
          </>
        ) : (!liveSessionsLoaded || externalLoading) ? (
          <div className="flex items-center justify-center gap-2 px-4 py-8 text-sm text-muted-foreground" role="status" aria-live="polite">
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-muted-foreground/40 border-t-muted-foreground" aria-hidden />
            {t('liveSessions.loading')}
          </div>
        ) : (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">
            {t('liveSessions.empty')}
          </div>
        )}
      </ScrollArea>

      <SidebarFooter
        clientRefreshAvailable={clientRefreshAvailable}
        serverUpdateAvailable={serverUpdateAvailable}
        latestVersion={latestVersion}
        currentVersion={currentVersion}
        onShowVersionModal={onShowVersionModal}
        onShowSettings={onShowSettings}
        t={t}
      />
    </div>
  );
}
