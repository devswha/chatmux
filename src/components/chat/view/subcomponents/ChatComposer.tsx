import type { ChatComposerProps } from './chatComposerTypes';
import ChatComposerFeedback from './ChatComposerFeedback';
import ChatComposerInputSurface from './ChatComposerInputSurface';

export default function ChatComposer(props: ChatComposerProps) {
  const hasQuestionPanel = props.pendingPermissionRequests.some(
    (request) => request.toolName === 'AskUserQuestion',
  );
  const hasPendingPermissions = props.pendingPermissionRequests.length > 0;
  const hasActivityIndicator = Boolean(props.activity && !hasPendingPermissions);

  return (
    <div className="chat-composer-shell relative flex-shrink-0 px-2 pb-2 pt-0 sm:px-4 sm:pb-4 md:px-4 md:pb-6">
      <ChatComposerFeedback
        activity={props.activity}
        commandError={props.commandError}
        handleGrantToolPermission={props.handleGrantToolPermission}
        handlePermissionDecision={props.handlePermissionDecision}
        isInputFocused={props.isInputFocused ?? false}
        onAbortSession={props.onAbortSession}
        onClearCommandError={props.onClearCommandError}
        onDeleteQueuedDraft={props.onDeleteQueuedDraft}
        onEditQueuedDraft={props.onEditQueuedDraft}
        pendingPermissionRequests={props.pendingPermissionRequests}
        queuedDraft={props.queuedDraft}
      />
      {!hasQuestionPanel && (
        <ChatComposerInputSurface {...props} hasActivityIndicator={hasActivityIndicator} />
      )}
    </div>
  );
}
