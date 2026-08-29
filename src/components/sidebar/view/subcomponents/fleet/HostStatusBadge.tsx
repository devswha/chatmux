/**
 * Explicit availability badge for one host.
 *
 * Every state is named in text, not only in colour: the sidebar is read in
 * forced-colours mode and by screen readers, where a coloured dot carries no
 * information at all. The dot is decoration on top of the label.
 */

import { useTranslation } from 'react-i18next';

import type { FleetPeerState } from '../../../../../../shared/fleet';
import type { HostSyncState } from '../../../../../fleet/discovery/hostCatalog';

const TONES = {
  connecting: { badge: 'bg-blue-500/15 text-blue-600 dark:text-blue-400', dot: 'animate-pulse bg-blue-500' },
  syncing: { badge: 'bg-blue-500/15 text-blue-600 dark:text-blue-400', dot: 'animate-pulse bg-blue-500' },
  online: { badge: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400', dot: 'bg-emerald-500' },
  degraded: { badge: 'bg-amber-500/15 text-amber-600 dark:text-amber-400', dot: 'bg-amber-500' },
  offline: { badge: 'bg-muted text-muted-foreground', dot: 'bg-muted-foreground/50' },
  revoked: { badge: 'bg-red-500/15 text-red-600 dark:text-red-400', dot: 'bg-red-500' },
  incompatible: { badge: 'bg-red-500/15 text-red-600 dark:text-red-400', dot: 'bg-red-500' },
} satisfies Record<FleetPeerState, { badge: string; dot: string }>;

/**
 * An online host that has not finished snapshotting reads as `syncing`: its rows
 * are on screen but not authoritative, and that is what the user must see.
 */
export function effectiveHostState(state: FleetPeerState, sync: HostSyncState): FleetPeerState {
  return state === 'online' && sync === 'syncing' ? 'syncing' : state;
}

type HostStatusBadgeProps = {
  state: FleetPeerState;
  sync: HostSyncState;
};

export default function HostStatusBadge({ state, sync }: HostStatusBadgeProps) {
  const { t } = useTranslation('sidebar');
  const effective = effectiveHostState(state, sync);
  const tone = TONES[effective];

  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold ${tone.badge}`}
      title={t(`hostGroups.statusDetail.${effective}`)}
      data-host-status={effective}
    >
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${tone.dot}`} aria-hidden />
      {t(`hostGroups.status.${effective}`)}
    </span>
  );
}
