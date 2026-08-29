import React, { lazy, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import { SquareTerminal } from 'lucide-react';

import type { MainContentProps } from '../types/types';
import { usePaletteOpsRegister } from '../../../contexts/PaletteOpsContext';
import { useUiPreferences } from '../../../hooks/useUiPreferences';
import { useFileOpenResolver } from '../../../hooks/useFileOpenResolver';
import { useEditorSidebar } from '../../code-editor/hooks/useEditorSidebar';
import { useFleetHost } from '../../../fleet/FleetSessionRoute';
import { useExternalPaneOutput } from '../hooks/useExternalPaneOutput';
import { useTranscriptCliTarget } from '../hooks/useTranscriptCliTarget';

import {
  shouldShowPendingRelay,
} from './externalAttachTargets';
import MainContentHeader from './subcomponents/MainContentHeader';
import MainContentStateView from './subcomponents/MainContentStateView';
import ErrorBoundary from './ErrorBoundary';
import ExternalTerminalShellView from './subcomponents/ExternalTerminalShellView';
import PendingRelayView from './subcomponents/PendingRelayView';
import TranscriptCliTab from './subcomponents/TranscriptCliTab';
import ExternalTranscriptViewSwitcher from './subcomponents/ExternalTranscriptViewSwitcher';

const ChatInterface = lazy(() => import('../../chat/view/ChatInterface'));
const EditorSidebar = lazy(() => import('../../code-editor/view/EditorSidebar'));

// Re-exported for stable imports; implementations live in externalAttachTargets.
export {
  buildExternalAttachTarget,
  buildTranscriptCliAttachTarget,
  paneStreamFallbackNeeded,
  paneStreamFrame,
  shouldShowPendingRelay,
} from './externalAttachTargets';

function MainContent({
  selectedProject,
  selectedSession,
  isSessionReadOnly,
  liveSessionTarget,
  liveSessionModel,
  liveSessionEffort,
  liveSessionName,
  liveSessionKind,
  liveSessionProcessing = false,
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
  const { activeSessionKey } = useFleetHost();
  const { showRawParameters, showThinking, showImagePreviews, sendByCtrlEnter } = preferences;

  const {
    externalTranscriptView,
    setExternalTranscriptView,
    transcriptCliTarget,
    transcriptCliAttachTarget,
    transcriptCliProviderLabel,
    transcriptCliTmuxName,
    externalOutputTarget,
  } = useTranscriptCliTarget({
    externalTerminal,
    externalTranscript,
    liveSessionKind,
    liveSessionName,
    liveSessionTarget,
  });
  const { externalPaneOutput, externalPaneError } = useExternalPaneOutput(externalOutputTarget);

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

  usePaletteOpsRegister({
    openFile: (filePath: string) => {
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
    return (
      <PendingRelayView
        externalTerminal={externalTerminal}
        externalTranscriptView={externalTranscriptView}
        setExternalTranscriptView={setExternalTranscriptView}
        externalPaneOutput={externalPaneOutput}
        isMobile={isMobile}
        onMenuClick={onMenuClick}
        onExternalTerminalClose={onExternalTerminalClose}
      />
    );
  }

  // Targets without a locally observable process remain terminal-only.
  if (externalTerminal) {
    return (
      <ExternalTerminalShellView
        externalTerminal={externalTerminal}
        isMobile={isMobile}
        onMenuClick={onMenuClick}
        onExternalTerminalClose={onExternalTerminalClose}
      />
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
        isMobile={isMobile}
        onMenuClick={onMenuClick}
      />

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className={`flex min-h-0 min-w-[200px] flex-col overflow-hidden ${editorExpanded ? 'hidden' : ''} flex-1`}>
          <div className="flex min-h-0 flex-1 flex-col">
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
                    // The composer's draft storage is keyed by the host owning the
                    // viewed session, so switching the host-qualified session must
                    // remount the chat surface: its first render has to read the
                    // new host's storage, not keep another host's mounted state.
                    key={activeSessionKey ?? 'no-session'}
                    selectedProject={selectedProject}
                    selectedSession={selectedSession}
                    isSessionReadOnly={isSessionReadOnly}
                    liveSessionTarget={liveSessionTarget}
                    liveSessionModel={liveSessionModel}
                    liveSessionEffort={liveSessionEffort}
                    liveSessionName={liveSessionName}
                    liveSessionKind={liveSessionKind}
                    liveSessionProcessing={liveSessionProcessing}
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
                    showImagePreviews={showImagePreviews}
                    sendByCtrlEnter={sendByCtrlEnter}
                    externalMessageUpdate={externalMessageUpdate}
                    newSessionTrigger={newSessionTrigger}
                  />
                </Suspense>
              </ErrorBoundary>
            </div>
            {transcriptCliTarget
              && transcriptCliProviderLabel
              && externalTranscriptView === 'cli' && (
              <TranscriptCliTab
                transcriptCliProviderLabel={transcriptCliProviderLabel}
                transcriptCliAttachTarget={transcriptCliAttachTarget}
                externalPaneError={externalPaneError}
                externalPaneOutput={externalPaneOutput}
                selectedProject={selectedProject}
                onBackToConversation={() => setExternalTranscriptView('conversation')}
              />
            )}
          </div>
        </div>

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
