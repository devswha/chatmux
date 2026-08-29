/**
 * The external transcript the URL currently points at, plus the live-session
 * relay target derived from it. Split from the former `AppContent.tsx`.
 */

import { useMemo } from 'react';

import { tmuxPaneIdentityKey, type TmuxPaneIdentity, type TmuxProcessGeneration } from '../../../../shared/tmux';
import { useFleetHostCatalog } from '../../../fleet/discovery/FleetHostCatalogContext';
import { useFleetHost } from '../../../fleet/FleetSessionRoute';
import type { ExternalTerminalTarget, ProjectSession } from '../../../types/app';

export type ActiveExternalTranscriptArgs = {
  externalTranscript: ExternalTerminalTarget | null;
  sessionId: string | undefined;
  selectedSession: ProjectSession | null;
  externalRunningPanes: ReadonlySet<string>;
  liveSessionLineage: ReadonlySet<string>;
  liveSessionTargets: ReadonlyMap<string, { tmux: TmuxPaneIdentity; process: TmuxProcessGeneration }>;
  liveSessionRunning: ReadonlySet<string>;
};

export function useActiveExternalTranscript({
  externalTranscript,
  sessionId,
  selectedSession,
  externalRunningPanes,
  liveSessionLineage,
  liveSessionTargets,
  liveSessionRunning,
}: ActiveExternalTranscriptArgs) {
  const fleetHost = useFleetHost();
  const { catalog } = useFleetHostCatalog();
  const activeHostId = fleetHost.activeSession?.hostId ?? fleetHost.localHostId;
  const localHostId = fleetHost.localHostId;
  const activeExternalTranscript = externalTranscript
    && externalTranscript.cliKind !== 'ssh'
    && externalTranscript.cliKind !== 'shell'
    && externalTranscript.cliKind !== 'gjc'
    && externalTranscript.transcriptSessionId === sessionId
    ? externalTranscript
    : null;

  // Relay only for exact pane and process generations. A cwd-only label may
  // point at another pane and is never actionable. Memoized: an inline object
  // literal here changes identity every render, which tears down MainContent's
  // pane-output polling effect and blanks the CLI output view (visible flicker).
  const liveSessionTarget = useMemo(() => {
    if (selectedSession && activeHostId && activeHostId !== localHostId) {
      const pane = catalog.hosts.get(activeHostId)?.rows.panes.find((row) => (
        row.providerSessionId === selectedSession.id
        && row.process !== null
        && row.presence === 'present'
      ));
      if (pane?.process) {
        return {
          hostId: activeHostId,
          localId: pane.localId,
          lane: pane.lane,
          tmux: pane.tmux,
          process: pane.process,
        };
      }
    }
    if (selectedSession && liveSessionLineage.has(selectedSession.id)) {
      return liveSessionTargets.get(selectedSession.id) ?? null;
    }
    return activeExternalTranscript?.process
      ? { tmux: activeExternalTranscript.tmux, process: activeExternalTranscript.process }
      : null;
  }, [
    selectedSession,
    activeHostId,
    localHostId,
    catalog,
    liveSessionLineage,
    liveSessionTargets,
    activeExternalTranscript,
  ]);

  // Drives the relay composer's send↔stop control for the viewed session.
  const liveSessionProcessing = activeExternalTranscript
    ? externalRunningPanes.has(tmuxPaneIdentityKey(activeExternalTranscript.tmux))
    : selectedSession
      ? liveSessionRunning.has(selectedSession.id)
      : false;

  return { activeExternalTranscript, liveSessionTarget, liveSessionProcessing };
}
