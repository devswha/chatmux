/**
 * The composer area under the message pane: the scroll-to-bottom pill, the
 * read-only relay composer (or its banner), and the interactive chat composer.
 * Split from the former `ChatInterface.tsx`.
 */

import { ArrowDownIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { ChatInterfaceProps } from '../../types/types';
import type { useChatInterfaceState } from '../../hooks/useChatInterfaceState';
import type { ChatSessionSurface } from '../../hooks/useChatSessionSurface';

import ChatComposer from './ChatComposer';
import ChatHostNotice from './ChatHostNotice';
import LiveRelayComposer from './LiveRelayComposer';

type InterfaceState = ReturnType<typeof useChatInterfaceState>;

type ChatComposerAreaProps = {
  surface: ChatSessionSurface;
  interfaceState: InterfaceState;
  selectedProject: ChatInterfaceProps['selectedProject'];
  selectedSession: ChatInterfaceProps['selectedSession'];
  isSessionReadOnly: ChatInterfaceProps['isSessionReadOnly'];
  liveSessionTarget: ChatInterfaceProps['liveSessionTarget'];
  liveSessionModel: ChatInterfaceProps['liveSessionModel'];
  liveSessionEffort: ChatInterfaceProps['liveSessionEffort'];
  liveSessionName: ChatInterfaceProps['liveSessionName'];
  liveSessionKind: ChatInterfaceProps['liveSessionKind'];
  liveSessionProcessing: boolean;
  sendByCtrlEnter: boolean | undefined;
};

export default function ChatComposerArea({
  surface,
  interfaceState,
  selectedProject,
  selectedSession,
  isSessionReadOnly,
  liveSessionTarget,
  liveSessionModel,
  liveSessionEffort,
  liveSessionName,
  liveSessionKind,
  liveSessionProcessing = false,
  sendByCtrlEnter,
}: ChatComposerAreaProps) {
  const { t } = useTranslation('chat');
  const { chat, provider: providerState, session } = surface;
  const { composer, relayAsk } = interfaceState;

  return (
    <div className="relative flex-shrink-0">
      {session.isUserScrolledUp && session.chatMessages.length > 0 && (
        <div className="pointer-events-none absolute -top-11 left-0 right-0 z-20 flex justify-center">
          <button
            type="button"
            onClick={session.scrollToBottomAndReset}
            aria-label={t('input.scrollToBottom', { defaultValue: 'Scroll to bottom' })}
            title={t('input.scrollToBottom', { defaultValue: 'Scroll to bottom' })}
            className={
              session.hasNewMessagesBelow
                ? 'pointer-events-auto flex h-8 items-center gap-1.5 rounded-full border border-primary/30 bg-primary px-3 text-xs font-medium text-primary-foreground shadow-md transition-all duration-200 hover:brightness-110'
                : 'pointer-events-auto flex h-8 w-8 items-center justify-center rounded-full border border-border/50 bg-card text-muted-foreground shadow-sm transition-all duration-200 hover:bg-accent hover:text-foreground'
            }
          >
            {session.hasNewMessagesBelow && (
              <span>{t('input.newMessages')}</span>
            )}
            <ArrowDownIcon className="h-4 w-4" aria-hidden />
          </button>
        </div>
      )}

      {/* The owning host's refusals and unresolved outcomes belong above the
          input, where the user reads before acting again. */}
      <ChatHostNotice blocked={chat.blocked} uncertainty={chat.uncertainty} onAcknowledge={chat.acknowledge} />

      {isSessionReadOnly ? (
        liveSessionTarget ? (
          // key: remount per exact pane target — a draft/in-flight status
          // must never survive a switch to another pane or process generation.
          <LiveRelayComposer
            key={`${liveSessionKind ?? 'gjc'}:${liveSessionTarget.tmux.paneId}:${liveSessionTarget.process.startedAtMs}`}
            target={liveSessionTarget}
            model={liveSessionModel}
            effort={liveSessionEffort}
            sessionName={liveSessionName}
            workspacePath={selectedProject?.fullPath || selectedProject?.path}
            relayKind={liveSessionKind ?? 'gjc'}
            isProcessing={liveSessionProcessing}
            transcriptSessionId={selectedSession?.id ?? null}
            pendingAsk={relayAsk.pendingRelayAsk}
            choiceSubmitRef={relayAsk.askChoiceSubmitRef}
          />
        ) : (
          <div className="chat-composer-shell relative flex-shrink-0 px-2 pb-3 pt-2 sm:px-4">
            <div className="mx-auto flex max-w-[54.25rem] items-center gap-2 rounded-xl border border-blue-500/30 bg-blue-500/10 px-4 py-3 text-sm text-blue-700 dark:text-blue-300">
              <span className="inline-flex h-2 w-2 shrink-0 animate-pulse rounded-full bg-blue-500" aria-hidden />
              <span>{t('readOnly.banner')}</span>
            </div>
          </div>
        )
      ) : (
        <ChatComposer
          pendingPermissionRequests={providerState.pendingPermissionRequests}
          handlePermissionDecision={composer.handlePermissionDecision}
          handleGrantToolPermission={composer.handleGrantToolPermission}
          activity={session.sessionActivity}
          isLoading={session.isProcessing}
          onAbortSession={composer.handleAbortSession}
          permissionMode={providerState.permissionMode}
          onModeSwitch={providerState.cyclePermissionMode}
          effort={providerState.currentProviderEffort}
          availableEffortOptions={providerState.currentProviderEffortOptions}
          onSelectEffort={(nextEffort) => providerState.setStoredProviderEffort(providerState.provider, nextEffort)}
          tokenBudget={session.tokenBudget}
          onShowTokenUsage={composer.showCostModal}
          slashCommandsCount={composer.slashCommandsCount}
          onToggleCommandMenu={composer.handleToggleCommandMenu}
          hasInput={Boolean(composer.input.trim())}
          onClearInput={composer.handleClearInput}
          onSubmit={composer.handleSubmit}
          commandError={composer.commandError}
          onClearCommandError={composer.clearCommandError}
          isDragActive={composer.isDragActive}
          queuedDraft={composer.queuedDraft}
          onEditQueuedDraft={composer.editQueuedDraft}
          onDeleteQueuedDraft={composer.deleteQueuedDraft}
          attachedImages={composer.attachedImages}
          onRemoveImage={(index) =>
            composer.setAttachedImages((previous) =>
              previous.filter((_, currentIndex) => currentIndex !== index),
            )
          }
          uploadingImages={composer.uploadingImages}
          imageErrors={composer.imageErrors}
          showFileDropdown={composer.showFileDropdown}
          filteredFiles={composer.filteredFiles}
          selectedFileIndex={composer.selectedFileIndex}
          onSelectFile={composer.selectFile}
          filteredCommands={composer.filteredCommands}
          selectedCommandIndex={composer.selectedCommandIndex}
          onCommandSelect={composer.handleCommandSelect}
          onCloseCommandMenu={composer.resetCommandMenuState}
          isCommandMenuOpen={composer.showCommandMenu}
          frequentCommands={composer.commandQuery ? [] : composer.frequentCommands}
          getRootProps={composer.getRootProps as (...args: unknown[]) => Record<string, unknown>}
          getInputProps={composer.getInputProps as (...args: unknown[]) => Record<string, unknown>}
          openImagePicker={composer.openImagePicker}
          inputHighlightRef={composer.inputHighlightRef}
          renderInputWithMentions={composer.renderInputWithMentions}
          textareaRef={composer.textareaRef}
          input={composer.input}
          onInputChange={composer.handleInputChange}
          onTextareaClick={composer.handleTextareaClick}
          onTextareaKeyDown={composer.handleKeyDown}
          onTextareaPaste={composer.handlePaste}
          onTextareaScrollSync={composer.syncInputOverlayScroll}
          onTextareaInput={composer.handleTextareaInput}
          isInputFocused={composer.isInputFocused}
          onInputFocusChange={composer.handleInputFocusChange}
          placeholder={typeof window !== 'undefined'
            && window.matchMedia?.('(max-width: 640px)').matches === true
            // The command/file hints wrap to a second line on phone widths.
            ? t('input.placeholderDefault', { defaultValue: 'Type your message...' })
            : t('input.placeholder', {
            provider:
              providerState.provider === 'cursor'
                ? t('messageTypes.cursor')
                : providerState.provider === 'codex'
                  ? t('messageTypes.codex')
                  : providerState.provider === 'opencode'
                    ? t('messageTypes.opencode', { defaultValue: 'OpenCode' })
                    : providerState.provider === 'gjc'
                      ? t('messageTypes.gjc', { defaultValue: 'Gajae Code' })
                      : providerState.provider === 'omp'
                        ? t('messageTypes.omp', { defaultValue: 'Oh My Pi' })
                        : t('messageTypes.claude'),
          })}
          isTextareaExpanded={composer.isTextareaExpanded}
          sendByCtrlEnter={sendByCtrlEnter}
        />
      )}
    </div>
  );
}
