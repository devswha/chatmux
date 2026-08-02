import { useState } from 'react';
import type { TFunction } from 'i18next';

import { ScrollArea } from '../../../../shared/view/ui';
import type { ExternalTerminalTarget, Project, ProjectSession } from '../../../../types/app';
import type { TmuxPaneIdentity, TmuxPaneTarget } from '../../../../../shared/tmux';
import { readPublicTerminalTarget } from '../../../../../shared/terminal-runtime';
import { api } from '../../../../utils/api';
import { useExternalCliSessions, type ExternalCliSession, type HerdrTerminalSession } from '../../hooks/useExternalCliSessions';

import SidebarFooter from './SidebarFooter';
import SidebarHeader from './SidebarHeader';
import SidebarLiveSection from './SidebarLiveSection';
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
  liveSessionPanes: ReadonlyMap<string, TmuxPaneIdentity>;
  liveSessionPresence: ReadonlyMap<string, 'present' | 'stale'>;
  liveSessionTargets: ReadonlyMap<string, TmuxPaneTarget>;
  liveSessionKinds: ReadonlyMap<string, string>;
  liveSessionRunning: ReadonlySet<string>;
  liveSessionErrors: ReadonlySet<string>;
  liveSessionsLoaded: boolean;
  onProjectSelect: (project: Project) => void;
  onSessionSelect: (session: ProjectSession, projectId?: string) => void;
  onRefresh: () => void;
  isRefreshing: boolean;
  onCollapseSidebar: () => void;
  clientRefreshAvailable: boolean;
  serverUpdateAvailable: boolean;
  installMode: 'source' | 'release' | 'unknown';
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
  liveSessionPanes,
  liveSessionPresence,
  liveSessionTargets,
  liveSessionKinds,
  liveSessionRunning,
  liveSessionErrors,
  liveSessionsLoaded,
  onProjectSelect,
  onSessionSelect,
  onRefresh,
  isRefreshing,
  onCollapseSidebar,
  clientRefreshAvailable,
  serverUpdateAvailable,
  installMode,
  latestVersion,
  currentVersion,
  onShowVersionModal,
  onShowSettings,
  onExternalTerminalOpen,
  onExternalSessionsChange,
  t,
}: SidebarContentProps) {
  const {
    sessions: externalSessions,
    herdrSessions,
    loading: externalLoading,
    refresh: refreshDiscoveredSessions,
  } = useExternalCliSessions(onExternalSessionsChange);
  const [herdrOpeningKey, setHerdrOpeningKey] = useState<string | null>(null);
  const [herdrOpenError, setHerdrOpenError] = useState<string | null>(null);
  // The hook's refresh sends a unified discovery resync, updating both live and external rows.
  const sessionCount = liveSessionIds.size + externalSessions.length + herdrSessions.length;
  const refreshAllSessions = () => {
    refreshDiscoveredSessions();
    onRefresh();
  };
  const openHerdr = async (session: HerdrTerminalSession, mode: 'observe' | 'control') => {
    if (herdrOpeningKey) return;
    setHerdrOpenError(null);
    if (mode === 'observe') {
      onExternalTerminalOpen({
        runtime: 'herdr',
        terminal: session.target,
        kind: 'Herdr',
        cliKind: 'herdr',
        project: null,
        mode,
      });
      return;
    }

    setHerdrOpeningKey(session.key);
    try {
      let controlTarget = session.target;
      if (session.target.targetClass === 'attach-only') {
        const response = await api.externalCliSessionAdmission(session.target);
        const body = await response.json().catch(() => null);
        const admitted = readPublicTerminalTarget(body?.data?.terminal);
        if (
          !response.ok
          || admitted?.runtime !== 'herdr'
          || admitted.targetClass !== 'attach-only'
          || admitted.sourceId !== session.target.sourceId
          || admitted.targetId !== session.target.targetId
        ) {
          throw new Error(body?.error?.message ?? 'Herdr control is unavailable.');
        }
        controlTarget = admitted;
      }
      onExternalTerminalOpen({
        runtime: 'herdr',
        terminal: controlTarget,
        kind: 'Herdr',
        cliKind: 'herdr',
        project: null,
        mode,
      });
    } catch (error) {
      setHerdrOpenError(error instanceof Error ? error.message : 'Herdr control is unavailable.');
    } finally {
      setHerdrOpeningKey(null);
    }
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
              externalSessions={externalSessions}
              selectedSession={selectedSession}
              onProjectSelect={onProjectSelect}
              onSessionSelect={onSessionSelect}
              liveSessionNames={liveSessionNames}
              liveSessionModels={liveSessionModels}
              liveSessionEfforts={liveSessionEfforts}
              liveSessionLineage={liveSessionLineage}
              liveSessionPanes={liveSessionPanes}
              liveSessionPresence={liveSessionPresence}
              liveSessionTargets={liveSessionTargets}
              liveSessionKinds={liveSessionKinds}
              liveSessionRunning={liveSessionRunning}
              liveSessionErrors={liveSessionErrors}
              onExternalTerminalOpen={onExternalTerminalOpen}
              onExternalSessionsChanged={refreshDiscoveredSessions}
            />
            {herdrSessions.length > 0 && (
              <div className="space-y-1 px-4 pb-3">
                <div className="px-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Herdr
                </div>
                {herdrSessions.map((session) => (
                  <div key={session.key} className="flex items-center justify-between gap-2 rounded-md border border-border/60 px-2 py-1.5">
                    <span className="min-w-0 truncate text-xs text-foreground">
                      {session.sourceId}
                    </span>
                    <span className="flex shrink-0 gap-1">
                      {session.capabilities.output && (
                        <button type="button" className="rounded px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground" onClick={() => void openHerdr(session, 'observe')}>
                          View
                        </button>
                      )}
                      {session.capabilities.attach && (
                        <button type="button" disabled={herdrOpeningKey === session.key} className="rounded bg-emerald-700 px-2 py-1 text-xs text-white disabled:opacity-50" onClick={() => void openHerdr(session, 'control')}>
                          {herdrOpeningKey === session.key ? 'Opening…' : 'Control'}
                        </button>
                      )}
                    </span>
                  </div>
                ))}
                {herdrOpenError && (
                  <div role="alert" className="px-1 text-xs text-red-500">{herdrOpenError}</div>
                )}
              </div>
            )}
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
        installMode={installMode}
        latestVersion={latestVersion}
        currentVersion={currentVersion}
        onShowVersionModal={onShowVersionModal}
        onShowSettings={onShowSettings}
        t={t}
      />
    </div>
  );
}
