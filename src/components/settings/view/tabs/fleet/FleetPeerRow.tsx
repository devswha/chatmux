import { useEffect, useRef, useState } from 'react';
import { RefreshCw, ShieldOff, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { FleetSettingsPeer } from '../../../fleet/types';

type Props = Readonly<{
  readonly peer: FleetSettingsPeer;
  readonly pending: boolean;
  readonly onReconnect: (peerId: string) => Promise<void>;
  readonly onRevoke: (peerId: string) => Promise<void>;
  readonly onRemoveLocal: (peerId: string) => Promise<void>;
}>;

const stateColor = {
  online: 'text-emerald-600 dark:text-emerald-400',
  connecting: 'text-blue-600 dark:text-blue-400',
  syncing: 'text-blue-600 dark:text-blue-400',
  degraded: 'text-amber-600 dark:text-amber-400',
  offline: 'text-muted-foreground',
  revoked: 'text-destructive',
  incompatible: 'text-destructive',
} as const;

export function FleetPeerRow({ peer, pending, onReconnect, onRevoke, onRemoveLocal }: Props) {
  const { t, i18n } = useTranslation('settings');
  const [confirming, setConfirming] = useState(false);
  const rowRef = useRef<HTMLElement>(null);
  const revokeTriggerRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const openedRef = useRef(false);
  useEffect(() => {
    if (!confirming) {
      if (openedRef.current) revokeTriggerRef.current?.focus();
      return undefined;
    }
    confirmRef.current?.focus();
    const cancel = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        setConfirming(false);
      }
    };
    document.addEventListener('keydown', cancel, { capture: true });
    return () => document.removeEventListener('keydown', cancel, { capture: true });
  }, [confirming]);
  const lastSeen = peer.lastSeenAtMs === null
    ? t('fleet.neverSeen')
    : new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }).format(peer.lastSeenAtMs);
  return (
    <article ref={rowRef} tabIndex={-1} className="space-y-3 p-4 outline-none" aria-label={peer.displayLabel}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="max-w-full truncate text-sm font-semibold text-foreground" title={peer.displayLabel}>{peer.displayLabel}</h4>
            <span className={`text-xs font-medium ${stateColor[peer.state]}`}>{t(`fleet.states.${peer.state}`)}</span>
          </div>
          <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">{peer.peerFingerprint}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {peer.enrollmentState === 'enrolled' ? (
            <>
              <button type="button" disabled={pending} onClick={() => void onReconnect(peer.peerId)}
                className="flex h-9 items-center gap-2 rounded-md border border-border px-3 text-xs font-medium hover:bg-accent disabled:opacity-50">
                <RefreshCw className="h-3.5 w-3.5" />{t('fleet.actions.reconnect')}
              </button>
              <button ref={revokeTriggerRef} type="button" disabled={pending} onClick={() => { openedRef.current = true; setConfirming(true); }}
                className="flex h-9 items-center gap-2 rounded-md border border-destructive/40 px-3 text-xs font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50">
                <ShieldOff className="h-3.5 w-3.5" />{t('fleet.actions.revoke')}
              </button>
            </>
          ) : (
            <button type="button" disabled={pending} onClick={() => void onRemoveLocal(peer.peerId)}
              className="flex h-9 items-center gap-2 rounded-md border border-destructive/40 px-3 text-xs font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50">
              <Trash2 className="h-3.5 w-3.5" />{t('fleet.actions.removeLocal')}
            </button>
          )}
        </div>
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-3">
        <div><dt className="text-muted-foreground">{t('fleet.fields.mode')}</dt><dd className="mt-0.5 text-foreground">{peer.transportMode}</dd></div>
        <div><dt className="text-muted-foreground">{t('fleet.fields.version')}</dt><dd className="mt-0.5 text-foreground">{peer.protocolVersion ?? t('fleet.unknown')}</dd></div>
        <div><dt className="text-muted-foreground">{t('fleet.fields.lastSeen')}</dt><dd className="mt-0.5 text-foreground">{lastSeen}</dd></div>
      </dl>
      <p className="break-words text-xs text-muted-foreground">{peer.capabilities.length > 0 ? peer.capabilities.join(' · ') : t('fleet.noCapabilities')}</p>
      {confirming && (
        <div role="alertdialog" aria-labelledby={`fleet-revoke-title-${peer.peerId}`} aria-describedby={`fleet-revoke-description-${peer.peerId}`} className="flex flex-col gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h5 id={`fleet-revoke-title-${peer.peerId}`} className="sr-only">{t('fleet.confirm.title')}</h5>
            <p id={`fleet-revoke-description-${peer.peerId}`} className="break-keep text-xs leading-relaxed text-foreground [overflow-wrap:anywhere]">{t('fleet.confirm.description')}</p>
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={() => setConfirming(false)} className="h-9 rounded-md border border-border px-3 text-xs font-medium">{t('fleet.actions.cancel')}</button>
            <button ref={confirmRef} type="button" disabled={pending} onClick={() => { setConfirming(false); void onRevoke(peer.peerId).then(() => rowRef.current?.focus()); }} className="h-9 rounded-md bg-destructive px-3 text-xs font-medium text-destructive-foreground disabled:opacity-50">{t('fleet.actions.confirmRevoke')}</button>
          </div>
        </div>
      )}
    </article>
  );
}
