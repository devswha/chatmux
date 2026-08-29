/**
 * Routing rules for external terminal targets: identity comparison, attach
 * capability refresh, and the transcript-versus-terminal decision. Split from
 * the former `AppContent.tsx` — import through `AppContent` (facade) or here.
 */

import type { ExternalCliSession } from '../../components/sidebar/hooks/useExternalCliSessions';
import type { ExternalTerminalTarget } from '../../types/app';

export const isSameExternalTerminal = (
  current: ExternalTerminalTarget | null,
  expected: ExternalTerminalTarget,
): boolean => Boolean(
  current
  && current.hostId === expected.hostId
  && current.cliKind === expected.cliKind
  && current.tmux.socketPath === expected.tmux.socketPath
  && current.tmux.sessionId === expected.tmux.sessionId
  && current.tmux.windowId === expected.tmux.windowId
  && current.tmux.paneId === expected.tmux.paneId
  && (
    current.process === null && expected.process === null
    || current.process !== null
      && expected.process !== null
      && current.process.pid === expected.process.pid
      && current.process.startedAtMs === expected.process.startedAtMs
  ),
);
export function refreshExternalTerminalAttachCapability(
  target: ExternalTerminalTarget | null,
  sessions: readonly ExternalCliSession[],
): ExternalTerminalTarget | null {
  if (!target || target.hostId !== undefined || target.cliKind === 'gjc') {
    return target;
  }

  const session = sessions.find((candidate) => (
    candidate.authority !== 'none'
    && candidate.presence !== 'stale'
    && candidate.kind === target.cliKind
    && candidate.tmux.socketPath === target.tmux.socketPath
    && candidate.tmux.sessionId === target.tmux.sessionId
    && candidate.tmux.windowId === target.tmux.windowId
    && candidate.tmux.paneId === target.tmux.paneId
  ));
  if (!session) {
    return null;
  }

  if (target.cliKind === 'ssh' || target.cliKind === 'shell') {
    return session.attachCapability
      ? { ...target, attachCapability: session.attachCapability }
      : null;
  }

  return session.process
    && target.process
    && session.process.pid === target.process.pid
    && session.process.startedAtMs === target.process.startedAtMs
    ? {
        ...target,
        process: session.process,
        projectPath: session.projectPath ?? target.projectPath,
        transcriptSessionId: session.transcriptSessionId,
        sessionName: session.sessionName ?? target.sessionName,
        model: session.model ?? target.model,
        effort: session.effort ?? target.effort,
      }
    : null;
}
export function resolveExternalTerminalRoute(
  target: ExternalTerminalTarget,
): 'transcript' | 'terminal' {
  // B8: a forced attach always wins — it exists specifically so the
  // asking_user badge can bypass the structured transcript and land the
  // user on the exact pane's terminal, even once that pane is indexed.
  if (target.forceAttach) {
    return 'terminal';
  }
  if (
    target.cliKind !== 'gjc'
    && target.cliKind !== 'ssh'
    && target.cliKind !== 'shell'
    && target.transcriptSessionId
    && target.project
  ) {
    return 'transcript';
  }
  return 'terminal';
}

