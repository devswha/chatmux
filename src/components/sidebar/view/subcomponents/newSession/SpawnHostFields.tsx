/**
 * Host and project selection for the new-session form.
 *
 * The host list is the availability decision, not a label: a peer that is
 * offline, resynchronizing, protocol-incompatible or without the spawn
 * capability is absent, so the form cannot dispatch a request that is certain to
 * fail. When no peer is enrolled nothing is rendered at all and the form looks
 * exactly as it did before the fleet existed.
 *
 * A peer spawn is addressed to one of that peer's own projects, because the peer
 * verifies project ownership before it touches its filesystem. Those rows come
 * from the catalog the discovery stream already publishes.
 */

import { useTranslation } from 'react-i18next';

import type { FleetHostProjectRow } from '../../../../../fleet/discovery/hostRows';
import type { SpawnHostChoice } from '../../../../../fleet/hostAvailability';
import { cn } from '../../../../../lib/utils';

type SpawnHostFieldsProps = {
  hosts: readonly SpawnHostChoice[];
  selected: SpawnHostChoice;
  projects: readonly FleetHostProjectRow[];
  projectLocalId: string | null;
  onSelectHost: (hostId: string | null) => void;
  onSelectProject: (projectLocalId: string | null) => void;
};

export default function SpawnHostFields({
  hosts,
  selected,
  projects,
  projectLocalId,
  onSelectHost,
  onSelectProject,
}: SpawnHostFieldsProps) {
  const { t } = useTranslation('sidebar');
  if (hosts.length < 2) {
    return null;
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1" role="group" aria-label={t('newSessionForm.hostLabel')}>
        {hosts.map((host) => (
          <button
            key={host.hostId ?? 'local'}
            type="button"
            aria-pressed={host.hostId === selected.hostId}
            data-spawn-host={host.hostId ?? 'local'}
            onClick={() => onSelectHost(host.hostId)}
            className={cn(
              'rounded-md px-2 py-1 text-xs font-medium transition-colors',
              host.hostId === selected.hostId
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {host.isLocal ? t('newSessionForm.thisMachine') : host.label}
          </button>
        ))}
      </div>
      {!selected.isLocal && (
        <label className="block space-y-1">
          <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            {t('newSessionForm.hostProjectLabel')}
          </span>
          <select
            value={projectLocalId ?? ''}
            data-spawn-project
            onChange={(event) => onSelectProject(event.target.value === '' ? null : event.target.value)}
            className="w-full rounded-md border border-border bg-transparent px-2 py-1.5 text-sm outline-none focus:border-primary/60"
          >
            <option value="">{t('newSessionForm.hostProjectPlaceholder')}</option>
            {projects.map((project) => (
              <option key={project.localId} value={project.localId}>{project.displayName}</option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}
