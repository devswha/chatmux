/**
 * External terminal/transcript state for the app shell.
 *
 * Owns the taken-over external target (terminal or transcript), the roster of
 * external panes running a turn, and the open/close actions: opening an
 * indexed local agent routes to its structured transcript, everything else
 * attaches a terminal. Local coding-agent targets switch to structured
 * transcripts when indexed; terminal attach is the fallback before indexing
 * and the only view for SSH/shell. Split from the former `AppContent.tsx`.
 */

import { useCallback, useState } from 'react';

import { tmuxPaneIdentityKey } from '../../../../shared/tmux';
import type { ExternalTerminalTarget, Project, ProjectSession } from '../../../types/app';
import type { ExternalCliSession } from '../../sidebar/hooks/useExternalCliSessions';
import type { ServerEvent } from '../../../contexts/WebSocketContext';
import { refreshExternalTerminalAttachCapability, resolveExternalTerminalRoute  } from '../externalTerminalRouting';
import { useExternalTerminalDiscoveryAuthority } from '../useExternalTerminalDiscoveryAuthority';

export type ExternalTerminalStateWiring = {
  setActiveTab: (tab: 'chat') => void;
  setSidebarOpen: (open: boolean) => void;
  onProjectSelect: (project: Project) => unknown;
  onSessionSelect: (session: ProjectSession) => unknown;
  projects: readonly Project[];
  subscribe: (listener: (event: ServerEvent) => void) => () => void;
};

export function useExternalTerminalState({
  setActiveTab,
  setSidebarOpen,
  onProjectSelect,
  onSessionSelect,
  projects,
  subscribe,
}: ExternalTerminalStateWiring) {
  const [externalTerminal, setExternalTerminal] = useState<ExternalTerminalTarget | null>(null);
  const [externalTranscript, setExternalTranscript] = useState<ExternalTerminalTarget | null>(null);
  // Pane keys of external sessions currently running a turn. Fed by the same
  // sidebar-published roster as attach capability; no extra request is added.
  const [externalRunningPanes, setExternalRunningPanes] = useState<ReadonlySet<string>>(new Set());
  const refreshExternalTerminalCapability = useCallback((sessions: ExternalCliSession[]) => {
    setExternalTerminal((current) => refreshExternalTerminalAttachCapability(current, sessions));
    setExternalRunningPanes((current) => {
      const next = new Set(sessions
        .filter((session) => session.activity === 'running')
        .map((session) => tmuxPaneIdentityKey(session.tmux)));
      if (next.size === current.size && [...next].every((key) => current.has(key))) return current;
      return next;
    });
  }, []);

  const openExternalTerminal = useCallback((
    target: ExternalTerminalTarget,
    options?: { forceAttach?: boolean },
  ) => {
    // The approval-pending badge asks for the interactive pane rather than the
    // indexed transcript, so fold its request into the target before routing.
    const routed: ExternalTerminalTarget = options?.forceAttach ? { ...target, forceAttach: true } : target;
    if (
      routed.cliKind !== 'gjc'
      && routed.cliKind !== 'ssh'
      && routed.cliKind !== 'shell'
      && routed.transcriptSessionId
      && routed.project
      && resolveExternalTerminalRoute(routed) === 'transcript'
    ) {
      setExternalTerminal(null);
      setExternalTranscript(routed);
      setActiveTab('chat');
      onProjectSelect(routed.project);
      onSessionSelect({
        id: routed.transcriptSessionId,
        summary: routed.sessionName ?? '',
        __provider: routed.cliKind,
        __projectId: routed.project.projectId,
      });
      setSidebarOpen(false);
      return;
    }
    setExternalTranscript(null);
    setExternalTerminal(routed);
    setSidebarOpen(false);
  }, [onProjectSelect, onSessionSelect, setActiveTab, setSidebarOpen]);

  const closeExternalTerminal = useCallback(() => {
    setExternalTerminal(null);
    setExternalTranscript(null);
  }, []);

  useExternalTerminalDiscoveryAuthority({
    externalTerminal,
    setExternalTerminal,
    setExternalTranscript,
    openExternalTerminal,
    setActiveTab,
    sidebarSharedProps: { projects, onProjectSelect, onSessionSelect },
    subscribe,
  });

  return {
    externalTerminal,
    setExternalTerminal,
    externalTranscript,
    setExternalTranscript,
    externalRunningPanes,
    refreshExternalTerminalCapability,
    openExternalTerminal,
    closeExternalTerminal,
  };
}
