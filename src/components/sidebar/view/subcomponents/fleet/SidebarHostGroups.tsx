/**
 * Host grouping for the sidebar's session list.
 *
 * Wraps the existing local sections. With no enrolled peer it renders them and
 * nothing else, so a single-machine install keeps exactly its pre-fleet sidebar,
 * including the local REST fallback those sections own. With peers enrolled it
 * adds the machine dimension: a filter, the local machine first, then one region
 * per peer with its explicit availability.
 *
 * The local sections are passed through as `children` and never re-created here,
 * so peer state churn cannot re-render them — their pending destructive
 * confirmation belongs to the local host and must survive any peer failure.
 */

import { type ReactNode, useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import { useFleetHostCatalog } from '../../../../../fleet/discovery/FleetHostCatalogContext';
import {
  type HostGroup,
  type HostGroupCounts,
  type HostGroupRow,
  hostGroups,
  type LocalHostSummary,
} from '../../../../../fleet/discovery/hostGroups';
import { sessionRef } from '../../../../../fleet/references';
import type { ExternalTerminalTarget } from '../../../../../types/app';
import { sessionRoutePath } from '../../../../../fleet/sessionRoute';

import SidebarHostFilter from './SidebarHostFilter';
import SidebarHostGroup from './SidebarHostGroup';
import SidebarRemoteHostRows from './SidebarRemoteHostRows';

export type SidebarHostGroupsProps = {
  /** What the local sections are already rendering, for labels and counts. */
  local: {
    readonly rowLabels: readonly string[];
    readonly counts: HostGroupCounts;
  };
  children: ReactNode;
  onRemotePaneOpen: (target: ExternalTerminalTarget) => void;
};

function cliKind(kind: string): ExternalTerminalTarget['cliKind'] | null {
  switch (kind.toLowerCase()) {
    case 'claude': return 'claude';
    case 'codex': return 'codex';
    case 'cursor': return 'cursor';
    case 'opencode': return 'opencode';
    case 'gjc': return 'gjc';
    case 'omp': return 'omp';
    case 'omo': return 'omo';
    default: return null;
  }
}

export default function SidebarHostGroups({ local, children, onRemotePaneOpen }: SidebarHostGroupsProps) {
  const { t } = useTranslation('sidebar');
  const navigate = useNavigate();
  const { catalog } = useFleetHostCatalog();
  const [selectedHostId, setSelectedHostId] = useState<string | null>(null);

  const summary = useMemo<LocalHostSummary>(() => ({
    label: t('hostGroups.localLabel'),
    rowLabels: local.rowLabels,
    counts: local.counts,
  }), [local.counts, local.rowLabels, t]);
  const allGroups = useMemo(
    () => hostGroups({ catalog, local: summary, filter: null }),
    [catalog, summary],
  );
  const visibleGroups = useMemo(
    () => hostGroups({ catalog, local: summary, filter: selectedHostId }),
    [catalog, selectedHostId, summary],
  );

  const openRow = useCallback((group: HostGroup, row: HostGroupRow) => {
    const kind = row.pane === null ? null : cliKind(row.pane.kind);
    if (row.pane?.process && kind) {
      onRemotePaneOpen({
        hostId: group.hostId,
        hostLabel: group.label,
        localId: row.pane.localId,
        lane: row.pane.lane,
        tmuxName: row.pane.tmuxName,
        tmux: row.pane.tmux,
        process: row.pane.process,
        kind: row.pane.kind,
        cliKind: kind,
        project: null,
      });
      return;
    }
    navigate(sessionRoutePath(sessionRef(group.hostId, row.localId), catalog.localHostId));
  }, [catalog.localHostId, navigate, onRemotePaneOpen]);

  if (allGroups.length === 0) {
    return <>{children}</>;
  }

  return (
    <div className="flex flex-col">
      <SidebarHostFilter
        groups={allGroups}
        selectedHostId={selectedHostId}
        onSelect={setSelectedHostId}
      />
      {visibleGroups.map((group) => (
        <SidebarHostGroup key={group.hostId} group={group}>
          {group.isLocal
            ? children
            : <SidebarRemoteHostRows group={group} onSelect={(row) => openRow(group, row)} />}
        </SidebarHostGroup>
      ))}
    </div>
  );
}
