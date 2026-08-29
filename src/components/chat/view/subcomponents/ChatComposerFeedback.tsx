import { XIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { ChatComposerProps } from './chatComposerTypes';
import ActivityIndicator from './ActivityIndicator';
import PermissionRequestsBanner from './PermissionRequestsBanner';
import QueuedMessageCard from './QueuedMessageCard';

type ChatComposerFeedbackProps = Pick<
  ChatComposerProps,
  | 'activity'
  | 'commandError'
  | 'handleGrantToolPermission'
  | 'handlePermissionDecision'
  | 'isInputFocused'
  | 'onAbortSession'
  | 'onClearCommandError'
  | 'onDeleteQueuedDraft'
  | 'onEditQueuedDraft'
  | 'pendingPermissionRequests'
  | 'queuedDraft'
>;

export default function ChatComposerFeedback({
  activity,
  commandError,
  handleGrantToolPermission,
  handlePermissionDecision,
  isInputFocused,
  onAbortSession,
  onClearCommandError,
  onDeleteQueuedDraft,
  onEditQueuedDraft,
  pendingPermissionRequests,
  queuedDraft,
}: ChatComposerFeedbackProps) {
  const { t } = useTranslation('chat');
  const hasPendingPermissions = pendingPermissionRequests.length > 0;

  return (
    <>
      {!hasPendingPermissions && (
        <div className="pointer-events-none relative z-10 mx-auto max-w-[54.25rem] bg-transparent">
          <ActivityIndicator activity={activity} onAbort={onAbortSession} isInputFocused={isInputFocused} />
        </div>
      )}

      {hasPendingPermissions && (
        <div className="mx-auto mb-3 max-w-[54.25rem]">
          <PermissionRequestsBanner
            pendingPermissionRequests={pendingPermissionRequests}
            handlePermissionDecision={handlePermissionDecision}
            handleGrantToolPermission={handleGrantToolPermission}
          />
        </div>
      )}

      {queuedDraft && (
        <QueuedMessageCard
          content={queuedDraft.content}
          imageCount={queuedDraft.images.length}
          onEdit={onEditQueuedDraft}
          onDelete={onDeleteQueuedDraft}
        />
      )}

      {commandError && (
        <div className="mx-auto mb-2 flex max-w-[54.25rem] items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive" role="alert">
          <span className="min-w-0 flex-1 break-words">
            {t('input.sendFailed', { defaultValue: 'Command failed' })}: {commandError}
          </span>
          <button
            type="button"
            onClick={onClearCommandError}
            className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded hover:bg-destructive/10"
            aria-label={t('input.dismissError', { defaultValue: 'Dismiss error' })}
            title={t('input.dismissError', { defaultValue: 'Dismiss error' })}
          >
            <XIcon className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </>
  );
}
