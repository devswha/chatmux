import React, { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Menu, MessageSquare, SquareTerminal, X } from 'lucide-react';

import type { MainContentProps } from '../types/types';
import { useTaskMaster } from '../../../contexts/TaskMasterContext';
import { usePaletteOpsRegister } from '../../../contexts/PaletteOpsContext';
import { useTasksSettings } from '../../../contexts/TasksSettingsContext';
import { useUiPreferences } from '../../../hooks/useUiPreferences';
import { useFileOpenResolver } from '../../../hooks/useFileOpenResolver';
import { authenticatedFetch, api } from '../../../utils/api';
import { useEditorSidebar } from '../../code-editor/hooks/useEditorSidebar';
import LiveRelayComposer from '../../chat/view/subcomponents/LiveRelayComposer';
import type { ExternalTerminalTarget, Project } from '../../../types/app';
import type { ShellAttachTarget } from '../../shell/types/types';
import { paneSubscriptionKey, tmuxPaneIdentityKey, type TmuxPaneIdentity, type TmuxProcessGeneration } from '../../../../shared/tmux';
import { useWebSocket } from '../../../contexts/WebSocketContext';

import MainContentHeader from './subcomponents/MainContentHeader';
import MainContentStateView from './subcomponents/MainContentStateView';
import ErrorBoundary from './ErrorBoundary';
import PendingExternalCliOutput from './subcomponents/PendingExternalCliOutput';
import ExternalTranscriptViewSwitcher, {
  type ExternalTranscriptView,
} from './subcomponents/ExternalTranscriptViewSwitcher';

const PluginTabContent = lazy(() => import('../../plugins/view/PluginTabContent'));
const ChatInterface = lazy(() => import('../../chat/view/ChatInterface'));
const StandaloneShell = lazy(() => import('../../standalone-shell/view/StandaloneShell'));
const EditorSidebar = lazy(() => import('../../code-editor/view/EditorSidebar'));
const FilesPanel = lazy(() => import('./subcomponents/FilesPanel'));
const BrowserUsePanel = lazy(() => import('../../browser-use').then((module) => ({
  default: module.BrowserUsePanel,
})));
const TaskMasterPanel = lazy(() => import('../../task-master').then((module) => ({
  default: module.TaskMasterPanel,
})));

type TaskMasterContextValue = {
  currentProject?: Project | null;
  setCurrentProject?: ((project: Project) => void) | null;
};

type TasksSettingsContextValue = {
  tasksEnabled: boolean;
  isTaskMasterInstalled: boolean | null;
  isTaskMasterReady: boolean | null;
};
export function paneStreamFrame(
  event: { kind?: unknown; key?: unknown; subscriptionId?: unknown; output?: unknown },
  targetKey: string,
  subscriptionId: string | null,
): { subscriptionId: string; output?: string; invalidated: boolean } | null {
  if (event.kind === 'pane.attached') {
    if (event.key !== targetKey || typeof event.subscriptionId !== 'string') return null;
    return {
      subscriptionId: event.subscriptionId,
      ...(typeof event.output === 'string' ? { output: event.output } : {}),
      invalidated: false,
    };
  }
  if ((event.kind !== 'pane.output' && event.kind !== 'pane.invalidated') || event.subscriptionId !== subscriptionId || subscriptionId === null) return null;
  return {
    subscriptionId,
    ...(typeof event.output === 'string' ? { output: event.output } : {}),
    invalidated: event.kind === 'pane.invalidated',
  };
}
export function paneStreamFallbackNeeded(isConnected: boolean, streamSubscribed: boolean): boolean {
  return !isConnected || !streamSubscribed;
}
export function shouldShowPendingRelay(externalTerminal: ExternalTerminalTarget | null): boolean {
  // B8: a forced attach (from the asking_user badge) always skips the
  // pending relay surface and goes straight to terminal attach below, even
  // for a session whose process is still observable.
  return Boolean(
    externalTerminal
    && externalTerminal.cliKind !== 'ssh'
    && externalTerminal.cliKind !== 'shell'
    && externalTerminal.process
    && !externalTerminal.forceAttach,
  );
}
export function buildExternalAttachTarget(externalTerminal: ExternalTerminalTarget): ShellAttachTarget | null {
  const isAttachOnly = externalTerminal.cliKind === 'ssh'
    || externalTerminal.cliKind === 'shell'
    || !externalTerminal.process;
  const attachCapability = 'attachCapability' in externalTerminal
    ? externalTerminal.attachCapability
    : undefined;
  if (isAttachOnly) {
    return typeof attachCapability === 'string' && attachCapability
      ? { targetClass: 'attach-only', tmux: externalTerminal.tmux, capability: attachCapability }
      : null;
  }
  return { targetClass: 'local-agent', tmux: externalTerminal.tmux, process: externalTerminal.process! };
}

/**
 * The CLI output tab upgrades from a read-only pane mirror to a fully
 * interactive terminal whenever the pane's process generation is observable:
 * the same exact-4-tuple typed-attach protocol as the terminal route, so all
 * server-side identity checks apply unchanged. Without a process identity the
 * tab stays read-only (never attach by tmux name alone).
 */
export function buildTranscriptCliAttachTarget(
  target: { tmux: TmuxPaneIdentity; process?: TmuxProcessGeneration | null } | null | undefined,
): Extract<ShellAttachTarget, { targetClass: 'local-agent' }> | null {
  if (!target?.process) {
    return null;
  }
  return { targetClass: 'local-agent', tmux: target.tmux, process: target.process };
}
 


function MainContent({
  selectedProject,
  selectedSession,
  isSessionReadOnly,
  liveSessionTarget,
  liveSessionModel,
  liveSessionEffort,
  liveSessionName,
  liveSessionKind,
  activeTab,
  setActiveTab,
  ws,
  sendMessage,
  isMobile,
  onMenuClick,
  isLoading,
  onInputFocusChange,
  onSessionProcessing,
  onSessionIdle,
  processingSessions,
  onNavigateToSession,
  onSessionEstablished,
  onShowSettings,
  externalMessageUpdate,
  newSessionTrigger,
  externalTranscript,
  externalTerminal,
  onExternalTerminalClose,
}: MainContentProps) {
  const { preferences } = useUiPreferences();
  const { t } = useTranslation('chat');
  const { showRawParameters, showThinking, sendByCtrlEnter } = preferences;

  const { currentProject, setCurrentProject } = useTaskMaster() as TaskMasterContextValue;
  const { tasksEnabled, isTaskMasterInstalled } = useTasksSettings() as TasksSettingsContextValue;
  const [browserUseEnabled, setBrowserUseEnabled] = useState(false);
  const [externalPaneOutput, setExternalPaneOutput] = useState('');
  const [externalPaneError, setExternalPaneError] = useState('');
  const [externalTranscriptView, setExternalTranscriptView] = useState<ExternalTranscriptView>('conversation');
  const transcriptCliTarget = useMemo(() => {
    if (externalTranscript?.process) {
      return {
        tmux: externalTranscript.tmux,
        process: externalTranscript.process,
        lane: 'external' as const,
      };
    }
    if (liveSessionKind === 'gjc' && liveSessionTarget) {
      return {
        ...liveSessionTarget,
        lane: 'live' as const,
      };
    }
    return null;
  }, [externalTranscript, liveSessionKind, liveSessionTarget]);
  const transcriptCliAttachTarget = useMemo(
    () => buildTranscriptCliAttachTarget(transcriptCliTarget),
    [transcriptCliTarget],
  );
  const transcriptCliProviderLabel = externalTranscript?.kind
    ?? (liveSessionKind === 'gjc' ? 'GJC' : null);
  const transcriptCliTmuxName = externalTranscript?.tmuxName
    ?? (liveSessionKind === 'gjc' ? liveSessionName : null);
  const externalOutputTarget = useMemo(() => {
    if (externalTranscriptView !== 'cli') {
      return null;
    }
    if (externalTerminal && externalTerminal.cliKind !== 'ssh' && externalTerminal.cliKind !== 'shell') {
      // Attachable panes mount the interactive terminal instead; the
      // read-only mirror stream would just duplicate the same bytes.
      return null;
    }
    // Attach-capable transcript targets also use the interactive terminal.
    return transcriptCliAttachTarget ? null : transcriptCliTarget;
  }, [externalTerminal, externalTranscriptView, transcriptCliAttachTarget, transcriptCliTarget]);
  const [filesPanelOpen, setFilesPanelOpen] = useState(() => {
    try {
      return localStorage.getItem('files-panel-open') === 'true';
    } catch {
      return false;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem('files-panel-open', String(filesPanelOpen));
    } catch {
      // storage errors are non-fatal
    }
  }, [filesPanelOpen]);

  const externalViewTargetKey = transcriptCliTarget
    ? tmuxPaneIdentityKey(transcriptCliTarget.tmux)
    : externalTerminal
      ? tmuxPaneIdentityKey(externalTerminal.tmux)
      : null;

  useEffect(() => {
    setExternalTranscriptView('conversation');
  }, [externalViewTargetKey]);

  const shouldShowTasksTab = Boolean(tasksEnabled && isTaskMasterInstalled);
  const shouldShowBrowserTab = browserUseEnabled;

  const {
    editingFile,
    editorWidth,
    editorExpanded,
    hasManualWidth,
    resizeHandleRef,
    handleFileOpen,
    handleCloseEditor,
    handleToggleEditorExpand,
    handleResizeStart,
  } = useEditorSidebar({
    selectedProject,
    isMobile,
  });

  // Resolves bare/partial file references (e.g. links inside chat messages) to
  // real project files before opening them in the in-app editor.
  const resolvedFileOpen = useFileOpenResolver(selectedProject, handleFileOpen);

  useEffect(() => {
    // Identify projects by DB `projectId`; the TaskMaster context uses the
    // same identifier to key its internal maps.
    const selectedProjectId = selectedProject?.projectId;
    const currentProjectId = currentProject?.projectId;

    if (selectedProject && selectedProjectId !== currentProjectId) {
      setCurrentProject?.(selectedProject);
    }
  }, [selectedProject, currentProject?.projectId, setCurrentProject]);

  useEffect(() => {
    if (!shouldShowTasksTab && activeTab === 'tasks') {
      setActiveTab('chat');
    }
  }, [shouldShowTasksTab, activeTab, setActiveTab]);

  useEffect(() => {
    // Shell/Git/Files tabs were removed; a persisted selection would render a
    // blank main area, so bounce it back to chat (Files lives in FilesPanel).
    if (activeTab === 'shell' || activeTab === 'git' || activeTab === 'files') {
      setActiveTab('chat');
    }
  }, [activeTab, setActiveTab]);

  const loadBrowserUseSettings = useCallback(async () => {
    try {
      const response = await authenticatedFetch('/api/browser-use/settings');
      const data = await response.json();
      setBrowserUseEnabled(Boolean(response.ok && data?.success !== false && data?.data?.settings?.enabled));
    } catch {
      setBrowserUseEnabled(false);
    }
  }, []);

  useEffect(() => {
    void loadBrowserUseSettings();
    window.addEventListener('browserUseSettingsChanged', loadBrowserUseSettings);
    return () => window.removeEventListener('browserUseSettingsChanged', loadBrowserUseSettings);
  }, [loadBrowserUseSettings]);

  // The polling effect is keyed on a stable identity STRING, not the target
  // object: upstream props re-derive objects freely, and an identity-churned
  // dep would tear the effect down every render — blanking the pane for one
  // fetch round-trip each time (visible flicker). The ref feeds the interval
  // the latest equivalent object without retriggering the effect.
  const { isConnected, subscribe } = useWebSocket();
  const externalOutputTargetRef = useRef(externalOutputTarget);
  useEffect(() => {
    externalOutputTargetRef.current = externalOutputTarget;
  });
  const externalOutputTargetKey = externalOutputTarget
    ? paneSubscriptionKey(externalOutputTarget.lane, externalOutputTarget.tmux, externalOutputTarget.process)
    : null;

  useEffect(() => {
    if (!externalOutputTargetKey) {
      setExternalPaneOutput('');
      setExternalPaneError('');
      return undefined;
    }

    let cancelled = false;
    let subscriptionId: string | null = null;
    let streamSubscribed = false;
    let controller: AbortController | null = null;
    const loadOutput = async () => {
      const target = externalOutputTargetRef.current;
      if (!target) return;
      controller?.abort();
      controller = new AbortController();
      try {
        const response = target.lane === 'live'
          ? await api.liveSessionOutput(target.tmux, target.process, controller.signal)
          : await api.externalCliSessionOutput(target.tmux, target.process, controller.signal);
        const payload = await response.json().catch(() => null);
        if (cancelled) return;
        if (response.ok) {
          setExternalPaneOutput(typeof payload?.data?.output === 'string' ? payload.data.output : '');
          setExternalPaneError('');
        } else {
          // Keep the last frame: the error panel replaces the view, and a
          // transient failure recovering on the next tick should not flash
          // the empty state in between.
          setExternalPaneError(
            payload?.error?.message
              ?? t('transcript.cliLoadFailed'),
          );
        }
      } catch (error) {
        if (!cancelled && !(error instanceof DOMException && error.name === 'AbortError')) {
          setExternalPaneError(t('transcript.cliConnectionFailed'));
        }
      }
    };

    setExternalPaneOutput('');
    setExternalPaneError('');
    // One REST read preserves the rollback path when a stream is unavailable.
    void loadOutput();
    const unsubscribe = subscribe((event) => {
      const frame = paneStreamFrame(event, externalOutputTargetKey, subscriptionId);
      if (!frame || cancelled) return;
      subscriptionId = frame.subscriptionId;
      streamSubscribed = true;
      if (frame.invalidated) {
        setExternalPaneError(t('transcript.cliLoadFailed'));
      } else if (typeof frame.output === 'string') {
        setExternalPaneOutput(frame.output);
        setExternalPaneError('');
      }
    });
    if (isConnected) {
      const target = externalOutputTargetRef.current;
      if (target) sendMessage({
        type: 'pane.subscribe',
        protocolVersion: 1,
        lane: target.lane,
        tmux: target.tmux,
        process: target.process,
      });
    }
    const fallbackTimer = window.setInterval(() => {
      if (paneStreamFallbackNeeded(isConnected, streamSubscribed)) void loadOutput();
    }, 5_000);
    return () => {
      cancelled = true;
      window.clearInterval(fallbackTimer);
      unsubscribe();
      if (subscriptionId) sendMessage({ type: 'pane.unsubscribe', subscriptionId });
      controller?.abort();
    };
  }, [externalOutputTargetKey, isConnected, sendMessage, subscribe, t]);

  useEffect(() => {
    if (!shouldShowBrowserTab && activeTab === 'browser') {
      setActiveTab('chat');
    }
  }, [shouldShowBrowserTab, activeTab, setActiveTab]);

  usePaletteOpsRegister({
    openFile: (filePath: string) => {
      setActiveTab('files');
      handleFileOpen(filePath);
    },
    // Opens the editor side panel in place, keeping the current tab (e.g. chat).
    openFileInEditor: (filePath: string) => {
      resolvedFileOpen(filePath);
    },
  });

  if (isLoading) {
    return <MainContentStateView mode="loading" isMobile={isMobile} onMenuClick={onMenuClick} />;
  }

  // Fresh local panes open on an empty conversation surface. Raw tmux output
  // remains available behind the explicit CLI output tab instead of replacing
  // the chat before the provider creates its first transcript record.
  if (
    externalTerminal
    && externalTerminal.cliKind !== 'ssh'
    && externalTerminal.cliKind !== 'shell'
    && shouldShowPendingRelay(externalTerminal)
  ) {
    const isGjc = externalTerminal.cliKind === 'gjc';
    const providerLabel = {
      gjc: 'GJC',
      claude: 'Claude',
      codex: 'Codex',
      cursor: 'Cursor',
      opencode: 'OpenCode',
      omp: 'Oh My Pi',
    }[externalTerminal.cliKind];
    const pendingCliAttachTarget = buildTranscriptCliAttachTarget({
      tmux: externalTerminal.tmux,
      process: externalTerminal.process,
    });
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex flex-shrink-0 items-center justify-between border-b border-border/50 px-3 py-2">
          <div className="flex min-w-0 items-center gap-2">
            {isMobile && (
              <button
                type="button"
                onClick={onMenuClick}
                className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
                aria-label="Open sidebar"
              >
                <Menu className="h-4 w-4" />
              </button>
            )}
            <MessageSquare className="h-4 w-4 shrink-0 text-emerald-500" aria-hidden />
            <span className="truncate text-sm font-semibold text-foreground">{externalTerminal.tmuxName}</span>
            <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
              {t('transcript.pendingTitle', { provider: providerLabel })}
            </span>
          </div>
          <button
            type="button"
            onClick={onExternalTerminalClose}
            title={t('transcript.closeView', { provider: providerLabel })}
            className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <ExternalTranscriptViewSwitcher
          mode={externalTranscriptView}
          providerLabel={providerLabel}
          tmuxName={externalTerminal.tmuxName}
          onChange={setExternalTranscriptView}
        />
        {externalTranscriptView === 'cli' ? (
          pendingCliAttachTarget ? (
            <div className="min-h-0 flex-1 overflow-hidden">
              <Suspense fallback={null}>
                <StandaloneShell
                  // Switching exact pane targets or process generations must remount.
                  key={`pending-cli-${tmuxPaneIdentityKey(pendingCliAttachTarget.tmux)}:${pendingCliAttachTarget.process.startedAtMs}`}
                  project={externalTerminal.project}
                  attachTarget={pendingCliAttachTarget}
                  isActive
                  minimal
                />
              </Suspense>
            </div>
          ) : (
            <PendingExternalCliOutput providerLabel={providerLabel} output={externalPaneOutput} />
          )
        ) : (
          <PendingExternalCliOutput
            providerLabel={providerLabel}
            output=""
            emptyMessage={t('transcript.noConversationYet', { provider: providerLabel })}
          />
        )}
        <LiveRelayComposer
          key={`pending-${externalTerminal.cliKind}:${tmuxPaneIdentityKey(externalTerminal.tmux)}:${externalTerminal.process?.startedAtMs ?? 'unknown'}`}
          target={{ tmux: externalTerminal.tmux, process: externalTerminal.process! }}
          model={'model' in externalTerminal ? externalTerminal.model : null}
          effort={'effort' in externalTerminal ? externalTerminal.effort : null}
          sessionName={externalTerminal.tmuxName}
          workspacePath={isGjc ? null : (externalTerminal.project.fullPath || externalTerminal.project.path)}
          relayKind={externalTerminal.cliKind}
        />
      </div>
    );
  }

  // Targets without a locally observable process remain terminal-only.
  if (externalTerminal) {
    const targetKey = tmuxPaneIdentityKey(externalTerminal.tmux);
    const attachTarget = buildExternalAttachTarget(externalTerminal);
    return (
      <div className="flex h-full flex-col">
        <div className="flex flex-shrink-0 items-center justify-between border-b border-border/50 px-3 py-2">
          <div className="flex min-w-0 items-center gap-2">
            {isMobile && (
              <button
                type="button"
                onClick={onMenuClick}
                className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
                aria-label="Open sidebar"
              >
                <Menu className="h-4 w-4" />
              </button>
            )}
            <SquareTerminal className="h-4 w-4 shrink-0 text-emerald-500" aria-hidden />
            <span className="truncate text-sm font-semibold text-foreground">tmux: {externalTerminal.tmuxName}</span>
            <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
              {t('transcript.detachHint', { kind: externalTerminal.kind })}
            </span>
          </div>
          <button
            type="button"
            onClick={onExternalTerminalClose}
            title={t('transcript.closeTerminal')}
            className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-hidden">
          {attachTarget ? (
            <Suspense fallback={null}>
              <StandaloneShell
                // Switching exact pane targets must remount the Shell.
                key={targetKey}
                project={externalTerminal.project}
                attachTarget={attachTarget}
                isActive
                minimal
                onComplete={() => onExternalTerminalClose()}
              />
            </Suspense>
          ) : (
            <div role="alert" className="m-3 rounded-md border border-amber-700/60 bg-amber-950/40 px-3 py-2 text-sm text-amber-100">
              {t('shell.attachCapabilityUnavailable')}
            </div>
          )}
        </div>
      </div>
    );
  }

  if (!selectedProject) {
    return <MainContentStateView mode="empty" isMobile={isMobile} onMenuClick={onMenuClick} />;
  }

  return (
    <div className="flex h-full flex-col">
      <MainContentHeader
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        selectedProject={selectedProject}
        selectedSession={selectedSession}
        shouldShowTasksTab={shouldShowTasksTab}
        shouldShowBrowserTab={shouldShowBrowserTab}
        isMobile={isMobile}
        onMenuClick={onMenuClick}
        filesPanelOpen={filesPanelOpen}
        onToggleFilesPanel={() => setFilesPanelOpen((previous) => !previous)}
      />

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className={`flex min-h-0 min-w-[200px] flex-col overflow-hidden ${editorExpanded ? 'hidden' : ''} flex-1`}>
          <div className={`min-h-0 flex-1 ${activeTab === 'chat' ? 'flex flex-col' : 'hidden'}`}>
            {transcriptCliTarget && transcriptCliProviderLabel && transcriptCliTmuxName && (
              <ExternalTranscriptViewSwitcher
                mode={externalTranscriptView}
                providerLabel={transcriptCliProviderLabel}
                tmuxName={transcriptCliTmuxName}
                onChange={setExternalTranscriptView}
              />
            )}
            {externalTranscript && 'transcriptEnded' in externalTranscript && externalTranscript.transcriptEnded
              && externalTranscriptView === 'conversation' && (
              <div
                role="status"
                className="flex flex-shrink-0 items-start gap-2 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-xs text-amber-600 dark:text-amber-400"
              >
                <SquareTerminal className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" aria-hidden />
                <span>
                  {t('transcript.ended')}
                </span>
              </div>
            )}
            <div className={`min-h-0 flex-1 ${transcriptCliTarget && externalTranscriptView === 'cli' ? 'hidden' : 'block'}`}>
              <ErrorBoundary showDetails>
                <Suspense fallback={null}>
                  <ChatInterface
                    selectedProject={selectedProject}
                    selectedSession={selectedSession}
                    isSessionReadOnly={isSessionReadOnly}
                    liveSessionTarget={liveSessionTarget}
                    liveSessionModel={liveSessionModel}
                    liveSessionEffort={liveSessionEffort}
                    liveSessionName={liveSessionName}
                    liveSessionKind={liveSessionKind}
                    ws={ws}
                    sendMessage={sendMessage}
                    onFileOpen={handleFileOpen}
                    onInputFocusChange={onInputFocusChange}
                    onSessionProcessing={onSessionProcessing}
                    onSessionIdle={onSessionIdle}
                    processingSessions={processingSessions}
                    onNavigateToSession={onNavigateToSession}
                    onSessionEstablished={onSessionEstablished}
                    onShowSettings={onShowSettings}
                    showRawParameters={showRawParameters}
                    showThinking={showThinking}
                    sendByCtrlEnter={sendByCtrlEnter}
                    externalMessageUpdate={externalMessageUpdate}
                    newSessionTrigger={newSessionTrigger}
                    onShowAllTasks={tasksEnabled ? () => setActiveTab('tasks') : null}
                  />
                </Suspense>
              </ErrorBoundary>
            </div>
            {transcriptCliTarget
              && transcriptCliProviderLabel
              && externalTranscriptView === 'cli' && (
              <div
                role="tabpanel"
                aria-label={`${transcriptCliProviderLabel} ${t('transcript.cliTab')}`}
                className="flex min-h-0 flex-1 flex-col"
              >
                {transcriptCliAttachTarget ? (
                  <div className="min-h-0 flex-1 overflow-hidden">
                    <Suspense fallback={null}>
                      <StandaloneShell
                        // Switching exact pane targets or process generations must remount.
                        key={`transcript-cli-${tmuxPaneIdentityKey(transcriptCliAttachTarget.tmux)}:${transcriptCliAttachTarget.process.startedAtMs}`}
                        project={selectedProject}
                        attachTarget={transcriptCliAttachTarget}
                        isActive
                        minimal
                        onComplete={() => setExternalTranscriptView('conversation')}
                      />
                    </Suspense>
                  </div>
                ) : externalPaneError ? (
                  <div className="flex min-h-0 flex-1 items-center justify-center bg-zinc-950 px-6 text-center">
                    <div role="alert" className="max-w-md text-sm text-zinc-300">
                      <SquareTerminal className="mx-auto mb-3 h-5 w-5 text-amber-400" aria-hidden />
                      {externalPaneError}
                    </div>
                  </div>
                ) : (
                  <PendingExternalCliOutput
                    providerLabel={transcriptCliProviderLabel}
                    output={externalPaneOutput}
                    emptyMessage={t('transcript.cliLoading')}
                  />
                )}
              </div>
            )}
          </div>


          {shouldShowTasksTab && (
            <Suspense fallback={null}>
              <TaskMasterPanel isVisible={activeTab === 'tasks'} />
            </Suspense>
          )}

          {shouldShowBrowserTab && activeTab === 'browser' && (
            <div className="h-full overflow-hidden">
              <Suspense fallback={null}>
                <BrowserUsePanel isVisible />
              </Suspense>
            </div>
          )}

          {activeTab.startsWith('plugin:') && (
            <div className="h-full overflow-hidden">
              <Suspense fallback={null}>
                <PluginTabContent
                  pluginName={activeTab.replace('plugin:', '')}
                  selectedProject={selectedProject}
                  selectedSession={selectedSession}
                />
              </Suspense>
            </div>
          )}
        </div>

        {filesPanelOpen && (
          <div className="w-80 max-w-[85vw] flex-shrink-0 border-l border-border/60 bg-background md:w-72">
            <Suspense fallback={null}>
              <FilesPanel
                onFileOpen={(filePath, projectId) => handleFileOpen(filePath, null, { projectId })}
                onClose={() => setFilesPanelOpen(false)}
              />
            </Suspense>
          </div>
        )}

        {editingFile && (
          <Suspense fallback={null}>
            <EditorSidebar
              editingFile={editingFile}
              isMobile={isMobile}
              editorExpanded={editorExpanded}
              editorWidth={editorWidth}
              hasManualWidth={hasManualWidth}
              resizeHandleRef={resizeHandleRef}
              onResizeStart={handleResizeStart}
              onCloseEditor={handleCloseEditor}
              onToggleEditorExpand={handleToggleEditorExpand}
              projectPath={selectedProject.path}
              fillSpace={false}
            />
          </Suspense>
        )}
      </div>
    </div>
  );
}

export default React.memo(MainContent);
