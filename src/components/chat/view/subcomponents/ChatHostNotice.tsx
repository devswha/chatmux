/**
 * Non-success state for the host that owns the open session.
 *
 * Two things must be visible and neither may be silent. A refused frame says why
 * it was refused, and a dispatched mutation whose answer never arrived says the
 * outcome is unknown while the transcript is re-read from the owning host. Until
 * that reconciliation reports back, the composer refuses another send — this
 * notice is the reason the user sees instead of a stalled spinner or, worse, a
 * duplicate message.
 */

import { useTranslation } from 'react-i18next';

import type { ChatBlockReason } from '../../../../fleet/chat/chatFrames';
import type { RemoteSendUncertainty } from '../../../../fleet/chat/useHostQualifiedChat';

type ChatHostNoticeProps = {
  blocked: ChatBlockReason | null;
  uncertainty: RemoteSendUncertainty | null;
  onAcknowledge: () => void;
};

type Tone = 'info' | 'warning' | 'error';

const TONE_CLASS: Record<Tone, string> = {
  info: 'border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300',
  warning: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300',
  error: 'border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300',
};

function blockedKey(reason: ChatBlockReason): { readonly key: string; readonly tone: Tone } {
  switch (reason) {
    case 'host-unavailable':
      return { key: 'hostNotice.blocked.hostUnavailable', tone: 'error' };
    case 'host-syncing':
      return { key: 'hostNotice.blocked.hostSyncing', tone: 'warning' };
    case 'reconcile-required':
      return { key: 'hostNotice.blocked.reconcileRequired', tone: 'warning' };
    case 'session-mismatch':
      return { key: 'hostNotice.blocked.sessionMismatch', tone: 'error' };
    case 'attachments-unsupported':
      return { key: 'hostNotice.blocked.attachmentsUnsupported', tone: 'warning' };
    case 'unsupported-frame':
      return { key: 'hostNotice.blocked.unsupportedFrame', tone: 'warning' };
  }
}

function reconciledKey(evidence: RemoteSendUncertainty['evidence']): { readonly key: string; readonly tone: Tone } {
  switch (evidence) {
    case 'applied':
      return { key: 'hostNotice.uncertain.applied', tone: 'info' };
    case 'not-applied':
      return { key: 'hostNotice.uncertain.notApplied', tone: 'error' };
    case 'unknown':
      return { key: 'hostNotice.uncertain.unknown', tone: 'warning' };
  }
}

export default function ChatHostNotice({ blocked, uncertainty, onAcknowledge }: ChatHostNoticeProps) {
  const { t } = useTranslation('chat');
  const pending = uncertainty !== null && uncertainty.status === 'reconciling';
  const notice = uncertainty !== null
    ? (pending
      ? { key: 'hostNotice.uncertain.checking', tone: 'warning' as Tone, state: 'uncertain:reconciling', dismissible: false }
      : {
        ...reconciledKey(uncertainty.evidence),
        state: `uncertain:reconciled:${uncertainty.evidence}`,
        dismissible: true,
      })
    : blocked !== null
      ? { ...blockedKey(blocked), state: `blocked:${blocked}`, dismissible: false }
      : null;
  if (notice === null) {
    return null;
  }

  return (
    <div className="px-2 pb-1 sm:px-4">
      <div
        className={`mx-auto flex max-w-[54.25rem] items-center gap-2 rounded-xl border px-4 py-2 text-sm ${TONE_CLASS[notice.tone]}`}
        data-chat-host-notice={notice.state}
        role="status"
      >
        {pending && <span className="inline-flex h-2 w-2 shrink-0 animate-pulse rounded-full bg-current" aria-hidden />}
        <span className="flex-1">{t(notice.key)}</span>
        {notice.dismissible && (
          <button
            type="button"
            onClick={onAcknowledge}
            data-chat-host-notice-dismiss
            className="shrink-0 rounded-md px-2 py-0.5 text-xs font-medium underline-offset-2 transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {t('hostNotice.dismiss')}
          </button>
        )}
      </div>
    </div>
  );
}
