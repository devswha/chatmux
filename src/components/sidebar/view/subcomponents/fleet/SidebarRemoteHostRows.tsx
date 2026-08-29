/**
 * Session and live-pane rows for one remote host.
 *
 * A row is a target selector, nothing more: activating it opens the session on
 * its owning host. Whenever the host is not authoritative — connecting, syncing,
 * degraded, offline, revoked, incompatible — every row is a disabled native
 * button. Disabled buttons are not focusable and cannot be activated, so an
 * unavailable host cannot be retargeted by mouse or keyboard, while its last
 * known rows stay readable.
 */

import { useTranslation } from 'react-i18next';

import { cn } from '../../../../../lib/utils';
import type { HostGroup, HostGroupRow } from '../../../../../fleet/discovery/hostGroups';

import { hostDisplayLabel } from './hostLabels';
import { effectiveHostState } from './HostStatusBadge';

type SidebarRemoteHostRowsProps = {
  group: HostGroup;
  onSelect: (row: HostGroupRow) => void;
};

export default function SidebarRemoteHostRows({ group, onSelect }: SidebarRemoteHostRowsProps) {
  const { t } = useTranslation('sidebar');
  const host = hostDisplayLabel(group, t);
  const status = t(`hostGroups.status.${effectiveHostState(group.state, group.sync)}`);

  return (
    <div className="space-y-0.5 px-2 pb-2">
      {group.rows.map((row) => {
        const enabled = group.actionsEnabled && !row.stale;
        return (
        <button
          key={row.key}
          type="button"
          data-host-row="true"
          data-host-row-kind={row.kind}
          disabled={!enabled}
          aria-disabled={!enabled}
          aria-label={enabled
            ? t('hostGroups.openRow', { name: row.label, host })
            : t('hostGroups.disabledRow', { name: row.label, host, status })}
          onClick={() => {
            // `disabled` already blocks the browser's mouse and keyboard paths.
            // The guard keeps the rule fail-closed at the seam itself: an
            // unavailable host must never become an action target, however the
            // handler is reached.
            if (enabled) onSelect(row);
          }}
          className={cn(
            'flex w-full min-w-0 items-start gap-2 rounded-md px-1.5 py-1.5 text-left transition-colors',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            enabled ? 'hover:bg-muted/50' : 'cursor-not-allowed opacity-60',
          )}
        >
          <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/40" aria-hidden />
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="truncate text-sm font-medium text-foreground">{row.label}</span>
              {row.duplicateLabel && (
                <span className="shrink-0 rounded bg-secondary px-1.5 py-0.5 text-[10px] font-semibold text-secondary-foreground">
                  {t('hostGroups.hostChip', { host })}
                </span>
              )}
            </span>
            <span className="truncate text-[11px] text-muted-foreground">
              {row.stale ? `${row.detail} · ${t('hostGroups.stale')}` : row.detail}
            </span>
          </span>
        </button>
        );
      })}
    </div>
  );
}
