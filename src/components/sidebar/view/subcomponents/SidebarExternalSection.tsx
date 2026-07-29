import { useTranslation } from 'react-i18next';
import { Fragment, useEffect, useRef, useState } from 'react';
import { Server, SquareTerminal, X } from 'lucide-react';

import type { ExternalTerminalTarget, Project } from '../../../../types/app';
import { api } from '../../../../utils/api';
import type { ExternalCliSession } from '../../hooks/useExternalCliSessions';
import SessionProviderLogo from '../../../llm-logo-provider/SessionProviderLogo';
import { tmuxPaneIdentityKey } from '../../../../../shared/tmux';

import SessionCompletionBell from './SessionCompletionBell';
import SessionActivityBadge, { type SessionActivityState } from './SessionActivityBadge';

const KIND_LABEL: Record<ExternalCliSession['kind'], string> = {
  claude: 'Claude Code',
  codex: 'Codex CLI',
  cursor: 'Cursor',
  opencode: 'OpenCode',
  omp: 'Oh My Pi',
  ssh: 'ssh (remote)',
  shell: 'terminal',
};

const isAttachOnlyKind = (kind: ExternalCliSession['kind']): boolean => (
  kind === 'ssh' || kind === 'shell'
);

const sessionActivityState = (
  session: ExternalCliSession,
  canKill: boolean,
): SessionActivityState | null => {
  if (!canKill) return null;
  switch (session.activity ?? 'unknown') {
    case 'running':
      return 'running';
    case 'waiting_user':
      return 'ready';
    case 'asking_user':
      return 'input';
    case 'error':
      return 'error';
    case 'unknown':
      return session.transcriptSessionId ? null : 'ready';
  }
};

// Local coding-agent tmux sessions can be stopped; SSH and unclassified shell
// panes are attach-only.

const normalizeComparablePath = (value: string): string => (
  value.replace(/\\/g, '/').replace(/\/+$/, '')
);

export const resolveExternalSessionProject = (
  session: ExternalCliSession,
  projects: Project[],
): Project | null => {
  const normalizedSessionPath = session.projectPath
    ? normalizeComparablePath(session.projectPath)
    : '';
  return projects.find((project) => (
    normalizedSessionPath
    && normalizeComparablePath(project.fullPath || project.path || '') === normalizedSessionPath
  )) ?? projects[0] ?? null;
};

type SidebarExternalSectionProps = {
  sessions: ExternalCliSession[];
  projects: Project[];
  /** Opens a structured transcript when available, otherwise a full terminal. */
  onOpen: (target: ExternalTerminalTarget, options?: { forceAttach?: boolean }) => void;
  onChanged: () => void;
};

/**
 * Coding-agent, SSH, and unclassified shell rows for the unified sessions
 * list. Local agents open structured transcripts when indexed and use terminal
 * attach before then. SSH and shell panes are always attach-only.
 */
export default function SidebarExternalSection({ sessions, projects, onOpen, onChanged }: SidebarExternalSectionProps) {
  const { t } = useTranslation('sidebar');
  const [confirming, setConfirming] = useState<string | null>(null);
  const [killing, setKilling] = useState<string | null>(null);
  const [error, setError] = useState('');
  const pendingTranscriptRef = useRef<string | null>(null);
  // Attach-only rows need any project-shaped shell context. Local transcripts
  // must use their owning project so the selected session can actually render.
  const shellProject = projects[0] ?? null;

  const openSession = (session: ExternalCliSession) => {
    const sessionProject = resolveExternalSessionProject(session, projects);
    if (!sessionProject) return;
    pendingTranscriptRef.current = !isAttachOnlyKind(session.kind) && !session.transcriptSessionId
      ? tmuxPaneIdentityKey(session.tmux)
      : null;
    onOpen({
      tmuxName: session.tmuxName,
      tmux: session.tmux,
      process: session.process,
      kind: KIND_LABEL[session.kind],
      cliKind: session.kind,
      project: sessionProject,
      transcriptSessionId: session.transcriptSessionId,
      sessionName: session.sessionName,
      model: session.model,
      effort: session.effort,
      transcriptEnded: session.transcriptEnded,
      attachCapability: session.attachCapability,
    });
  };
  // B8: the asking_user badge is a dedicated entry point that always attaches
  // the terminal for this exact pane 4-tuple, bypassing the structured
  // transcript even when one is already indexed — the approval prompt only
  // exists in the live TUI.
  const attachToApproval = (session: ExternalCliSession) => {
    if (session.process === null) return;
    const sessionProject = resolveExternalSessionProject(session, projects);
    if (!sessionProject) return;
    // A prior row click may have armed the promotion effect for this pane. Once
    // the pane indexes, that effect would reopen it as a transcript and pull the
    // user off the attach they just asked for, so disarm it here.
    pendingTranscriptRef.current = null;
    onOpen({
      tmuxName: session.tmuxName,
      tmux: session.tmux,
      process: session.process,
      kind: KIND_LABEL[session.kind],
      cliKind: session.kind,
      project: sessionProject,
      transcriptSessionId: session.transcriptSessionId,
      sessionName: session.sessionName,
      model: session.model,
      effort: session.effort,
      transcriptEnded: session.transcriptEnded,
      attachCapability: session.attachCapability,
    }, { forceAttach: true });
  };

  useEffect(() => {
    const targetKey = pendingTranscriptRef.current;
    if (!targetKey) return;
    const session = sessions.find((candidate) => (
      tmuxPaneIdentityKey(candidate.tmux) === targetKey && candidate.transcriptSessionId
    ));
    if (!session) return;
    const sessionProject = resolveExternalSessionProject(session, projects);
    if (!sessionProject) return;
    pendingTranscriptRef.current = null;
    onOpen({
      tmuxName: session.tmuxName,
      tmux: session.tmux,
      process: session.process,
      kind: KIND_LABEL[session.kind],
      cliKind: session.kind,
      project: sessionProject,
      transcriptSessionId: session.transcriptSessionId,
      sessionName: session.sessionName,
      model: session.model,
      effort: session.effort,
      transcriptEnded: session.transcriptEnded,
      attachCapability: session.attachCapability,
    });
  }, [onOpen, sessions, projects]);

  const closeTmuxSession = async (session: ExternalCliSession) => {
    if (killing || !session.process) return;
    const key = tmuxPaneIdentityKey(session.tmux);
    setKilling(key);
    setError('');
    try {
      const response = await api.externalCliSessionKill(session.tmux, session.process, 'session');
      const body = await response.json().catch(() => null);
      if (response.ok && body?.data?.ok) {
        setConfirming(null);
        onChanged();
        return;
      }
      setError(body?.error?.message ?? body?.message ?? t('externalSessions.stopFailed'));
    } catch {
      setError(t('externalSessions.stopFailed'));
    } finally {
      setKilling(null);
    }
  };

  if (sessions.length === 0 || !shellProject) {
    return null;
  }

  return (
    <div className="space-y-0.5 px-1.5">
      {error && <p className="px-2 py-1 text-[11px] text-red-500">{error}</p>}
      {sessions.map((session) => {
        const key = tmuxPaneIdentityKey(session.tmux);
        const canKill = !isAttachOnlyKind(session.kind) && session.process !== null;
        const activityState = sessionActivityState(session, canKill);
        const isInputRequired = activityState === 'input';
        const completionDescriptor = (
          (session.kind === 'claude' || session.kind === 'codex' || session.kind === 'opencode' || session.kind === 'omp')
          && session.process
        ) ? {
          kind: 'external_generation' as const,
          session: {
            kind: session.kind,
            tmux: session.tmux,
            agentPid: session.process.pid,
            startedAtMs: session.process.startedAtMs,
          },
        } : null;
        const sessionName = session.sessionName?.trim();
        const primary = session.tmuxName;
        const metadata = [
          sessionName,
          session.model?.split('/').pop(),
          session.effort ? `${session.effort} effort` : null,
          KIND_LABEL[session.kind],
        ].filter(Boolean).join(' · ');
        return (
          <Fragment key={key}>
            <div className="flex items-start rounded-md transition-colors hover:bg-muted/50">
              {isInputRequired && (
                <button
                  type="button"
                  onClick={() => attachToApproval(session)}
                  aria-label={t('externalSessions.activity.approvalPendingAttach', { name: session.tmuxName })}
                  className="ml-2 mt-1.5 flex shrink-0 items-center gap-1.5 self-start rounded px-1 py-0.5 hover:bg-amber-500/10"
                >
                  <SessionActivityBadge state="input" />
                </button>
              )}
              <button
                type="button"
                onClick={() => openSession(session)}
                title={session.transcriptSessionId
                  ? `${primary} — ${metadata}`
                  : isAttachOnlyKind(session.kind)
                    ? t('externalSessions.viewInTerminal', { name: session.tmuxName })
                    : t('externalSessions.openConversation', { name: primary })}
                className="flex min-w-0 flex-1 items-start gap-2 px-2 py-1.5 text-left"
              >
                {session.kind === 'ssh' ? (
                  <Server className="mt-0.5 h-4 w-4 flex-shrink-0 text-slate-400" aria-hidden />
                ) : session.kind === 'shell' ? (
                  <SquareTerminal className="mt-0.5 h-4 w-4 flex-shrink-0 text-slate-400" aria-hidden />
                ) : (
                  <SessionProviderLogo provider={session.kind} className="mt-0.5 h-4 w-4 flex-shrink-0" />
                )}
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="flex items-center gap-2">
                    {activityState && !isInputRequired && (
                      <SessionActivityBadge state={activityState} />
                    )}
                    <span className="truncate text-sm font-medium text-foreground">{primary}</span>
                  </span>
                  <span className="truncate text-[11px] text-muted-foreground">
                    {metadata}
                  </span>
                </span>
                {isAttachOnlyKind(session.kind) && (
                  <SquareTerminal className="mt-1 h-3.5 w-3.5 shrink-0 text-muted-foreground/60" aria-hidden />
                )}
              </button>
              {completionDescriptor && (
                <SessionCompletionBell descriptor={completionDescriptor} className="m-1" />
              )}
              {canKill && (
                <button
                  type="button"
                  onClick={() => { setError(''); setConfirming(key); }}
                  title={t('externalSessions.closeSessionTitle', { name: session.tmuxName })}
                  aria-label={t('externalSessions.closeSessionTitle', { name: session.tmuxName })}
                  className="m-1 rounded p-1.5 text-muted-foreground/60 transition-colors hover:bg-red-500/10 hover:text-red-500"
                >
                  <X className="h-3.5 w-3.5" aria-hidden />
                </button>
              )}
            </div>
            {confirming === key && (
              <div className="mx-2 mb-1 flex items-center justify-end gap-1 rounded-md bg-muted/50 px-2 py-1.5 text-[11px]">
                <span className="mr-auto text-muted-foreground">
                  {killing === key
                    ? t('externalSessions.stopping')
                    : t('externalSessions.closeSessionConfirm', { name: session.tmuxName })}
                </span>
                {killing !== key && (
                  <>
                    <button
                      type="button"
                      onClick={() => void closeTmuxSession(session)}
                      className="rounded bg-red-600 px-2 py-0.5 font-medium text-white hover:bg-red-700"
                    >
                      {t('externalSessions.closeSession')}
                    </button>
                    <button type="button" onClick={() => setConfirming(null)} className="text-muted-foreground hover:text-foreground">
                      {t('externalSessions.cancel')}
                    </button>
                  </>
                )}
              </div>
            )}
          </Fragment>
        );
      })}
    </div>
  );
}
