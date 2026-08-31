/**
 * Host grouping for the sidebar's session list.
 *
 * Wraps the existing local sections. With no enrolled peer it renders them and
 * nothing else, so a single-machine install keeps exactly its pre-fleet sidebar,
 * including the local REST fallback those sections own. With peers enrolled it
 * adds the machine dimension: the local machine first, then one region per peer
 * with its explicit availability. The labelled regions are sufficient context,
 * so every host stays visible without a second row of filter controls.
 *
 * The local sections are passed through as `children` and never re-created here,
 * so peer state churn cannot re-render them — their pending destructive
 * confirmation belongs to the local host and must survive any peer failure.
 */

import { type ReactNode, useCallback, useMemo } from 'react';
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
import { useFleetHost } from '../../../../../fleet/FleetSessionRoute';

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
  onRemoteTranscriptOpen: () => void;
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

export default function SidebarHostGroups({
  local,
  children,
  onRemotePaneOpen,
  onRemoteTranscriptOpen,
}: SidebarHostGroupsProps) {
  const { t } = useTranslation('sidebar');
  const navigate = useNavigate();
  const { activeSession } = useFleetHost();
  const { catalog } = useFleetHostCatalog();
  const summary = useMemo<LocalHostSummary>(() => ({
    label: t('hostGroups.localLabel'),
    rowLabels: local.rowLabels,
    counts: local.counts,
  }), [local.counts, local.rowLabels, t]);
  const groups = useMemo(
    () => hostGroups({ catalog, local: summary, filter: null }),
    [catalog, summary],
  );

  const openRow = useCallback((group: HostGroup, row: HostGroupRow) => {
    if (row.transcriptLocalId !== null) {
      onRemoteTranscriptOpen();
      navigate(sessionRoutePath(
        sessionRef(group.hostId, row.transcriptLocalId),
        catalog.localHostId,
      ));
      return;
    }
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
  }, [catalog.localHostId, navigate, onRemotePaneOpen, onRemoteTranscriptOpen]);

  if (groups.length === 0) {
    return <>{children}</>;
  }

  return (
    <div className="flex flex-col">
      {groups.map((group) => (
        <SidebarHostGroup key={group.hostId} group={group}>
          {group.isLocal
            ? children
            : (
              <SidebarRemoteHostRows
                group={group}
                selectedLocalId={activeSession?.hostId === group.hostId ? activeSession.localId : null}
                onSelect={(row) => openRow(group, row)}
              />
            )}
        </SidebarHostGroup>
      ))}
    </div>
  );
}
