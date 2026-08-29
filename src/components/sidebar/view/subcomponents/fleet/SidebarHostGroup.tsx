/**
 * One machine's section of the sidebar.
 *
 * The section is a labelled region, so every row inside it is announced under
 * its host — that is what keeps two identically named sessions on two machines
 * distinguishable. An empty region says so explicitly, and a region that cannot
 * report says something different: "no sessions here" and "this machine cannot
 * tell us" are not the same fact and must never render the same way.
 */

import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Monitor, Server } from 'lucide-react';

import type { HostGroup } from '../../../../../fleet/discovery/hostGroups';

import HostStatusBadge, { effectiveHostState } from './HostStatusBadge';
import { hostDisplayLabel } from './hostLabels';

type SidebarHostGroupProps = {
  group: HostGroup;
  children: ReactNode;
};

export default function SidebarHostGroup({ group, children }: SidebarHostGroupProps) {
  const { t } = useTranslation('sidebar');
  const host = hostDisplayLabel(group, t);
  const status = t(`hostGroups.status.${effectiveHostState(group.state, group.sync)}`);
  const HostIcon = group.isLocal ? Monitor : Server;

  return (
    <section
      aria-label={t('hostGroups.regionLabel', { host, status })}
      data-host-id={group.hostId}
      data-host-local={String(group.isLocal)}
      data-host-emptiness={group.emptiness}
      data-host-truncated={String(group.truncated)}
      className="border-b border-border/60 last:border-b-0"
    >
      <div className="px-2 pt-2">
        <div className="flex items-start gap-1.5">
          <HostIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <span className="min-w-0 break-keep text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            {host}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 pl-5 pt-1">
          {group.isLocal && (
            <span className="shrink-0 rounded bg-secondary px-1.5 py-0.5 text-[10px] font-semibold text-secondary-foreground">
              {t('hostGroups.localChip')}
            </span>
          )}
          <HostStatusBadge state={group.state} sync={group.sync} />
          <span className="shrink-0 text-[10px] text-muted-foreground/80">
            {t('hostGroups.counts', group.counts)}
          </span>
        </div>
      </div>

      {group.truncated && (
        <p
          className="flex items-start gap-1.5 break-keep px-2 pt-1.5 text-[11px] text-amber-600 dark:text-amber-400"
          role="status"
        >
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
          <span>{t('hostGroups.truncated', { host })}</span>
        </p>
      )}

      {children}

      {group.emptiness !== 'populated' && (
        <p className="break-keep px-2 pb-2 pt-1.5 text-[11px] text-muted-foreground">
          {group.emptiness === 'empty'
            ? t('hostGroups.empty', { host })
            : t('hostGroups.unavailable', { host })}
        </p>
      )}
    </section>
  );
}
