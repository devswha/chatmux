import React from 'react';

import PermissionContext from '../../../contexts/PermissionContext';
import type { ChatInterfaceProps, Provider } from '../types/types';
import { useChatInterfaceState } from '../hooks/useChatInterfaceState';
import { useChatSessionSurface } from '../hooks/useChatSessionSurface';

import ChatComposerArea from './subcomponents/ChatComposerArea';
import ChatMessagesPane from './subcomponents/ChatMessagesPane';
import ChatNoProjectState from './subcomponents/ChatNoProjectState';
import CommandResultModal from './subcomponents/CommandResultModal';

/**
 * Chat surface composition root. State assembly lives in
 * `useChatSessionSurface` + `useChatInterfaceState`; this component only wires
 * the assembled view model into the pane/composer/modal layout.
 */
function ChatInterface(props: ChatInterfaceProps) {
  const {
    selectedProject,
    selectedSession,
    isSessionReadOnly,
    liveSessionTarget,
    liveSessionModel,
    liveSessionEffort,
    liveSessionName,
    liveSessionKind,
    liveSessionProcessing = false,
    onFileOpen,
    onShowSettings,
    showRawParameters,
    showThinking,
    showImagePreviews,
    sendByCtrlEnter,
  } = props;

  const surface = useChatSessionSurface(props);
  const interfaceState = useChatInterfaceState({ ...props, surface });
  const { provider: providerState, session } = surface;
  const { composer, permissionContextValue, hasActivityIndicator, relayAsk } = interfaceState;

  if (!selectedProject) {
    return <ChatNoProjectState provider={providerState.provider} />;
  }

  return (
    <PermissionContext.Provider value={permissionContextValue}>
      <div className="flex h-full min-h-0 flex-col">
        <ChatMessagesPane
          scrollContainerRef={session.scrollContainerRef}
          onWheel={session.handleScroll}
          onTouchMove={session.handleScroll}
          isLoadingSessionMessages={session.isLoadingSessionMessages}
          isProcessing={session.isProcessing}
          hasActivityIndicator={hasActivityIndicator}
          chatMessages={session.chatMessages}
          selectedSession={selectedSession}
          currentSessionId={session.currentSessionId}
          provider={providerState.provider}
          setProvider={(nextProvider) => providerState.setProvider(nextProvider as Provider)}
          textareaRef={composer.textareaRef}
          claudeModel={providerState.claudeModel}
          setClaudeModel={providerState.setClaudeModel}
          cursorModel={providerState.cursorModel}
          setCursorModel={providerState.setCursorModel}
          codexModel={providerState.codexModel}
          setCodexModel={providerState.setCodexModel}
          opencodeModel={providerState.opencodeModel}
          setOpenCodeModel={providerState.setOpenCodeModel}
          ompModel={providerState.ompModel}
          setOmpModel={providerState.setOmpModel}
          providerModelCatalog={providerState.providerModelCatalog}
          providerModelsLoading={providerState.providerModelsLoading}
          isLoadingMoreMessages={session.isLoadingMoreMessages}
          hasMoreMessages={session.hasMoreMessages}
          totalMessages={session.totalMessages}
          sessionMessagesCount={session.chatMessages.length}
          visibleMessageCount={session.visibleMessageCount}
          visibleMessages={session.visibleMessages}
          loadEarlierMessages={session.loadEarlierMessages}
          loadAllMessages={session.loadAllMessages}
          allMessagesLoaded={session.allMessagesLoaded}
          isLoadingAllMessages={session.isLoadingAllMessages}
          loadAllJustFinished={session.loadAllJustFinished}
          showLoadAllOverlay={session.showLoadAllOverlay}
          createDiff={session.createDiff}
          onFileOpen={onFileOpen}
          onShowSettings={onShowSettings}
          onGrantToolPermission={composer.handleGrantToolPermission}
          showRawParameters={showRawParameters}
          showThinking={showThinking}
          showImagePreviews={showImagePreviews}
          selectedProject={selectedProject}
          pendingAskToolId={relayAsk.pendingRelayAsk?.toolId ?? null}
          suppressedAskToolId={relayAsk.suppressedAskToolId}
          onAskChoiceSelect={relayAsk.handleAskChoiceSelect}
        />

        <ChatComposerArea
          surface={surface}
          interfaceState={interfaceState}
          selectedProject={selectedProject}
          selectedSession={selectedSession}
          isSessionReadOnly={isSessionReadOnly}
          liveSessionTarget={liveSessionTarget}
          liveSessionModel={liveSessionModel}
          liveSessionEffort={liveSessionEffort}
          liveSessionName={liveSessionName}
          liveSessionKind={liveSessionKind}
          liveSessionProcessing={liveSessionProcessing}
          sendByCtrlEnter={sendByCtrlEnter}
        />
      </div>

      <CommandResultModal
        payload={composer.commandModalPayload}
        onClose={composer.closeCommandModal}
        providerModelCatalog={providerState.providerModelCatalog}
        providerModelCacheCatalog={providerState.providerModelCacheCatalog}
        providerModelsRefreshing={providerState.providerModelsRefreshing}
        onHardRefreshProviderModels={providerState.hardRefreshProviderModels}
        currentSessionId={session.currentSessionId || selectedSession?.id || null}
        onSelectProviderModel={providerState.selectProviderModel}
      />
    </PermissionContext.Provider>
  );
}

export default React.memo(ChatInterface);
