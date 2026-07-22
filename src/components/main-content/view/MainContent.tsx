import React, { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { Menu, MessageSquare, SquareTerminal, X } from 'lucide-react';

import type { MainContentProps } from '../types/types';
import { useTaskMaster } from '../../../contexts/TaskMasterContext';
import { usePaletteOpsRegister } from '../../../contexts/PaletteOpsContext';
import { useTasksSettings } from '../../../contexts/TasksSettingsContext';
import { useUiPreferences } from '../../../hooks/useUiPreferences';
import { useFileOpenResolver } from '../../../hooks/useFileOpenResolver';
import { authenticatedFetch } from '../../../utils/api';
import { useEditorSidebar } from '../../code-editor/hooks/useEditorSidebar';
import LiveRelayComposer from '../../chat/view/subcomponents/LiveRelayComposer';
import type { Project } from '../../../types/app';

import MainContentHeader from './subcomponents/MainContentHeader';
import MainContentStateView from './subcomponents/MainContentStateView';
import ErrorBoundary from './ErrorBoundary';
import PendingExternalCliOutput from './subcomponents/PendingExternalCliOutput';

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

function MainContent({
  selectedProject,
  selectedSession,
  isSessionReadOnly,
  liveSessionTmuxName,
  liveSessionTmuxId,
  liveSessionModel,
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
  externalTerminal,
  onExternalTerminalClose,
}: MainContentProps) {
  const { preferences } = useUiPreferences();
  const { showRawParameters, showThinking, sendByCtrlEnter } = preferences;

  const { currentProject, setCurrentProject } = useTaskMaster() as TaskMasterContextValue;
  const { tasksEnabled, isTaskMasterInstalled } = useTasksSettings() as TasksSettingsContextValue;
  const [browserUseEnabled, setBrowserUseEnabled] = useState(false);
  const [externalPaneOutput, setExternalPaneOutput] = useState('');
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

  useEffect(() => {
    const terminal = externalTerminal;
    if (!terminal || terminal.cliKind === 'ssh') {
      setExternalPaneOutput('');
      return undefined;
    }

    let cancelled = false;
    let controller: AbortController | null = null;
    const loadOutput = async () => {
      controller?.abort();
      controller = new AbortController();
      try {
        const params = new URLSearchParams({ tmuxName: terminal.tmuxName });
        const response = await authenticatedFetch(
          `/api/providers/sessions/external/output?${params}`,
          { signal: controller.signal },
        );
        const payload = await response.json();
        if (!cancelled && response.ok) {
          setExternalPaneOutput(typeof payload?.data?.output === 'string' ? payload.data.output : '');
        }
      } catch (error) {
        if (!cancelled && !(error instanceof DOMException && error.name === 'AbortError')) {
          setExternalPaneOutput('');
        }
      }
    };

    setExternalPaneOutput('');
    void loadOutput();
    const interval = window.setInterval(() => void loadOutput(), 1_000);
    return () => {
      cancelled = true;
      controller?.abort();
      window.clearInterval(interval);
    };
  }, [externalTerminal]);

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

  // Fresh local agent panes have no transcript file until their first turn.
  // Keep them in the transcript-style surface from the start; the first prompt
  // is relayed to tmux, then AppContent switches to the indexed transcript.
  if (externalTerminal && externalTerminal.cliKind !== 'ssh') {
    const isGjc = externalTerminal.cliKind === 'gjc';
    const providerLabel = {
      gjc: 'GJC',
      claude: 'Claude',
      codex: 'Codex',
      cursor: 'Cursor',
      opencode: 'OpenCode',
      omp: 'Oh My Pi',
    }[externalTerminal.cliKind];
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
              {providerLabel} transcript 준비 중
            </span>
          </div>
          <button
            type="button"
            onClick={onExternalTerminalClose}
            title={`${providerLabel} 화면 닫기`}
            className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <PendingExternalCliOutput providerLabel={providerLabel} output={externalPaneOutput} />
        <LiveRelayComposer
          key={`pending-${externalTerminal.cliKind}:${externalTerminal.tmuxName}`}
          tmuxName={externalTerminal.tmuxName}
          tmuxId={isGjc ? externalTerminal.tmuxId : null}
          workspacePath={isGjc ? null : (externalTerminal.project.fullPath || externalTerminal.project.path)}
          relayKind={externalTerminal.cliKind}
        />
      </div>
    );
  }

  // Remote SSH remains a terminal-only target because its process and
  // transcript are not observable on the ChatMux host.
  if (externalTerminal) {
    const safeName = /^[A-Za-z0-9._-]{1,64}$/.test(externalTerminal.tmuxName) ? externalTerminal.tmuxName : null;
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
              {externalTerminal.kind} · 분리(detach): Ctrl+B → D
            </span>
          </div>
          <button
            type="button"
            onClick={onExternalTerminalClose}
            title="터미널 닫기"
            className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-hidden">
          {safeName && (
            <Suspense fallback={null}>
              <StandaloneShell
                // key: switching targets must remount the Shell — its websocket
                // does NOT reconnect when only initialCommand changes, so without
                // this the previous session's terminal keeps showing (stock→test).
                key={safeName}
                project={externalTerminal.project}
                command={`tmux attach-session -t '=${safeName}'`}
                isActive
                // minimal: drop the Shell's own status bar ("New Session" +
                // Disconnect/Restart) — our header above already names the
                // target and closes the view; minimal also auto-connects.
                minimal
                onComplete={() => onExternalTerminalClose()}
              />
            </Suspense>
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
          <div className={`h-full ${activeTab === 'chat' ? 'block' : 'hidden'}`}>
            <ErrorBoundary showDetails>
              <Suspense fallback={null}>
                <ChatInterface
                  selectedProject={selectedProject}
                  selectedSession={selectedSession}
                  isSessionReadOnly={isSessionReadOnly}
                  liveSessionTmuxName={liveSessionTmuxName}
                  liveSessionTmuxId={liveSessionTmuxId}
                  liveSessionModel={liveSessionModel}
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
