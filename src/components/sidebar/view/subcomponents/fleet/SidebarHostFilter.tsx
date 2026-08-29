/**
 * Machine filter for the session list.
 *
 * The chips are native buttons inside a labelled group, so the whole filter is
 * reachable and operable from the keyboard with no custom key handling. Every
 * enrolled host stays selectable regardless of its state — filtering to an
 * offline machine to read its last known rows is a legitimate thing to want.
 */

import { useTranslation } from 'react-i18next';

import { cn } from '../../../../../lib/utils';
import type { HostGroup } from '../../../../../fleet/discovery/hostGroups';

import { hostDisplayLabel } from './hostLabels';

type SidebarHostFilterProps = {
  groups: readonly HostGroup[];
  selectedHostId: string | null;
  onSelect: (hostId: string | null) => void;
};

const CHIP = 'shrink-0 rounded-full border px-2.5 py-0.5 text-[11px] transition-colors '
  + 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

export default function SidebarHostFilter({
  groups,
  selectedHostId,
  onSelect,
}: SidebarHostFilterProps) {
  const { t } = useTranslation('sidebar');

  return (
    <div
      role="group"
      aria-label={t('hostGroups.filterLabel')}
      className="flex flex-wrap items-center gap-1 px-2 pb-1.5 pt-2"
    >
      <button
        type="button"
        data-host-filter="all"
        aria-pressed={selectedHostId === null}
        onClick={() => onSelect(null)}
        className={cn(
          CHIP,
          selectedHostId === null
            ? 'border-primary/30 bg-primary/10 text-foreground'
            : 'border-border text-muted-foreground hover:bg-muted',
        )}
      >
        {t('hostGroups.filterAll')}
      </button>
      {groups.map((group) => {
        const label = hostDisplayLabel(group, t);
        const selected = selectedHostId === group.hostId;
        return (
          <button
            key={group.hostId}
            type="button"
            data-host-filter={group.hostId}
            aria-pressed={selected}
            title={t('hostGroups.filterHost', { host: label })}
            onClick={() => onSelect(group.hostId)}
            className={cn(
              CHIP,
              'max-w-[10rem] truncate',
              selected
                ? 'border-primary/30 bg-primary/10 text-foreground'
                : 'border-border text-muted-foreground hover:bg-muted',
              group.availability === 'unavailable' && !selected && 'opacity-70',
            )}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}
