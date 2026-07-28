import { Bell, BellOff, Loader2, Wrench } from 'lucide-react';
import { type MouseEvent, useId } from 'react';
import { useTranslation } from 'react-i18next';

import type { CompletionNotificationDescriptor } from '../../../../../shared/completion-notifications';
import { cn } from '../../../../lib/utils';
import { useCompletionNotifications } from '../../hooks/useCompletionNotifications';
import type { CompletionNotificationReason } from '../../context/CompletionNotificationsContext';

type SessionCompletionBellProps = {
  descriptor: CompletionNotificationDescriptor;
  className?: string;
};
type CompletionNotificationReasonLabel = { key: string; defaultValue: string };

const REASON_LABELS = {
  settings_changed: {
    key: 'completionNotifications.conflict',
    defaultValue: 'Completion notification settings changed. Try again.',
  },
  permission_denied: {
    key: 'completionNotifications.denied',
    defaultValue: 'Notification permission was denied',
  },
  permission_not_granted: {
    key: 'completionNotifications.denied',
    defaultValue: 'Notification permission was not granted',
  },
  secure_context_required: {
    key: 'completionNotifications.insecure',
    defaultValue: 'Completion notifications require a secure connection',
  },
  ios_install_required: {
    key: 'completionNotifications.iosInstall',
    defaultValue: 'Install this app to enable completion notifications on iOS',
  },
  unsupported: {
    key: 'completionNotifications.unsupported',
    defaultValue: 'Completion notifications are not supported on this device',
  },
  invalid_subscription: {
    key: 'completionNotifications.error',
    defaultValue: 'Completion notifications could not be checked',
  },
  target_unavailable: {
    key: 'completionNotifications.error',
    defaultValue: 'Completion notifications could not be checked',
  },
  request_failed: {
    key: 'completionNotifications.error',
    defaultValue: 'Completion notifications could not be checked',
  },
  refresh_failed: {
    key: 'completionNotifications.error',
    defaultValue: 'Completion notifications could not be checked',
  },
  timeout: {
    key: 'completionNotifications.timeout',
    defaultValue: 'Completion notifications timed out. Try again.',
  },
} satisfies Record<CompletionNotificationReason, CompletionNotificationReasonLabel>;
const APP_REPAIRABLE_REASONS: readonly CompletionNotificationReason[] = [
  'invalid_subscription',
];
const ENVIRONMENTAL_REASONS: readonly CompletionNotificationReason[] = [
  'permission_denied',
  'permission_not_granted',
  'secure_context_required',
  'ios_install_required',
  'unsupported',
];

/** A standalone row control; it must remain a sibling of row navigation controls. */
export default function SessionCompletionBell({ descriptor, className }: SessionCompletionBellProps) {
  const { t } = useTranslation('sidebar');
  const statusId = useId();
  const { status, setWatch, repairDevice } = useCompletionNotifications(descriptor);

  // Do not flash a speculative control: only an authoritative, eligible target
  // can be watched. This also keeps stale/ambiguous external generations inert.
  if (!status?.target || status.item?.reason !== 'eligible') return null;

  const watched = status.target.watched;
  const pending = status.pending;
  const paused = status.globalPaused;
  const reason = status.error as CompletionNotificationReason | null;
  const deviceNeedsRepair = watched && (
    status.device?.reason === 'device_endpoint_missing'
    || status.device?.reason === 'endpoint_not_registered'
    || (reason !== null && APP_REPAIRABLE_REASONS.includes(reason))
  );
  const reasonLabel = reason
    ? t(REASON_LABELS[reason].key, REASON_LABELS[reason].defaultValue)
    : null;
  const watchLabel = watched
    ? t('completionNotifications.disable', 'Disable completion notifications for this session')
    : t('completionNotifications.enable', 'Enable completion notifications for this session');
  const repairLabel = t('completionNotifications.repair', 'Repair completion notifications on this device');
  const statusText = [
    pending ? t('completionNotifications.pending', 'Updating completion notifications') : null,
    paused ? t('completionNotifications.paused', 'Completion notifications are paused globally') : null,
    reasonLabel,
  ].filter((text): text is string => text !== null).join(' ') || null;
  const Icon = pending ? Loader2 : paused ? BellOff : Bell;

  const stopRowNavigation = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
  };

  const environmentalReason = reason !== null && ENVIRONMENTAL_REASONS.includes(reason);

  return (
    <span className={cn('flex shrink-0 items-center gap-1', className)}>
      {statusText && (
        <span
          id={statusId}
          className={environmentalReason ? 'max-w-48 text-xs text-destructive' : 'sr-only'}
          role="status"
          aria-live="polite"
        >
          {statusText}
        </span>
      )}
      {deviceNeedsRepair && (
        <button
          type="button"
          title={repairLabel}
          aria-label={repairLabel}
          aria-describedby={statusText ? statusId : undefined}
          disabled={pending}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded text-destructive transition-colors hover:bg-primary/10 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-50 md:h-6 md:w-6"
          onClick={(event) => {
            stopRowNavigation(event);
            if (!pending) void repairDevice(descriptor);
          }}
        >
          <Wrench className="h-3.5 w-3.5" aria-hidden />
        </button>
      )}
      <button
        type="button"
        title={watchLabel}
        aria-label={watchLabel}
        aria-describedby={statusText ? statusId : undefined}
        aria-pressed={watched}
        disabled={pending}
        className={cn(
          'flex h-11 w-11 shrink-0 items-center justify-center rounded text-muted-foreground/70 transition-colors hover:bg-primary/10 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-50 md:h-6 md:w-6',
          watched && !paused && 'text-primary',
          reason && 'text-destructive',
        )}
        onClick={(event) => {
          stopRowNavigation(event);
          if (!pending) void setWatch(descriptor, !watched);
        }}
      >
        <Icon className={cn('h-3.5 w-3.5', pending && 'animate-spin motion-reduce:animate-none')} aria-hidden />
      </button>
    </span>
  );
}
