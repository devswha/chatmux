import { useTranslation } from 'react-i18next';
import { Fragment, useEffect, useRef, useState } from 'react';
import { Server, SquareTerminal, X } from 'lucide-react';

import type { ExternalTerminalTarget, Project } from '../../../../types/app';
import { api } from '../../../../utils/api';
import type { ExternalCliSession, ExternalSessionActivity } from '../../hooks/useExternalCliSessions';
import SessionProviderLogo from '../../../llm-logo-provider/SessionProviderLogo';
import { tmuxPaneIdentityKey } from '../../../../../shared/tmux';

import SessionCompletionBell from './SessionCompletionBell';

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

const activityBadge = (t: ReturnType<typeof useTranslation>['t'], activity: ExternalSessionActivity) => ({
  running: {
    label: 'RUN',
    title: t('externalSessions.activity.running'),
    className: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
    dotClassName: 'animate-pulse bg-emerald-500',
  },
  waiting_user: {
    label: t('externalSessions.activity.waitingUser'),
    title: t('externalSessions.activity.waitingUserTitle'),
    className: 'bg-blue-500/15 text-blue-600 dark:text-blue-400',
    dotClassName: 'bg-blue-500',
  },
  asking_user: {
    label: t('externalSessions.activity.approvalPending'),
    title: t('externalSessions.activity.approvalPendingTitle'),
    className: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
    dotClassName: 'animate-pulse bg-amber-500',
  },
  unknown: {
    label: t('externalSessions.activity.unknown'),
    title: t('externalSessions.activity.unknownTitle'),
    className: 'bg-muted text-muted-foreground',
    dotClassName: 'bg-muted-foreground/50',
  },
} satisfies Record<ExternalSessionActivity, {
  label: string;
  title: string;
  className: string;
  dotClassName: string;
}>)[activity];

const notStartedBadge = (t: ReturnType<typeof useTranslation>['t']) => ({
  label: t('externalSessions.activity.notStarted'),
  title: t('externalSessions.activity.notStartedTitle'),
  className: 'bg-slate-500/15 text-slate-600 dark:text-slate-400',
  dotClassName: 'bg-slate-400',
});

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

  const stopSession = async (
    session: ExternalCliSession,
    mode: 'process' | 'pane' | 'session',
  ) => {
    if (killing || !session.process) return;
    const key = tmuxPaneIdentityKey(session.tmux);
    setKilling(key);
    setError('');
    try {
      const response = await api.externalCliSessionKill(session.tmux, session.process, mode);
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
        const activity = session.activity ?? 'unknown';
        const isNotStarted = canKill && activity === 'unknown' && !session.transcriptSessionId;
        const activityBadgeForSession = canKill
          ? (isNotStarted ? notStartedBadge(t) : activityBadge(t, activity))
          : null;
        const isApprovalPending = canKill && session.activity === 'asking_user';
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
              {isApprovalPending && (
                <button
                  type="button"
                  onClick={() => attachToApproval(session)}
                  title={t('externalSessions.activity.approvalPendingAttach', { name: session.tmuxName })}
                  aria-label={t('externalSessions.activity.approvalPendingAttach', { name: session.tmuxName })}
                  className="ml-2 mt-1.5 flex shrink-0 items-center gap-1.5 self-start rounded px-1 py-0.5 hover:bg-amber-500/10"
                >
                  <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${activityBadgeForSession!.dotClassName}`} aria-hidden />
                  <span
                    className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold ${activityBadgeForSession!.className}`}
                    title={activityBadgeForSession!.title}
                  >
                    {activityBadgeForSession!.label}
                  </span>
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
                    {activityBadgeForSession && !isApprovalPending && (
                      <>
                        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${activityBadgeForSession.dotClassName}`} aria-hidden />
                        <span
                          className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold ${activityBadgeForSession.className}`}
                          title={activityBadgeForSession.title}
                          aria-label={activityBadgeForSession.title}
                        >
                          {activityBadgeForSession.label}
                        </span>
                      </>
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
                  title={t('externalSessions.stopOptions', { name: session.tmuxName })}
                  aria-label={t('externalSessions.stopOptions', { name: session.tmuxName })}
                  className="m-1 rounded p-1.5 text-muted-foreground/60 transition-colors hover:bg-red-500/10 hover:text-red-500"
                >
                  <X className="h-3.5 w-3.5" aria-hidden />
                </button>
              )}
            </div>
            {confirming === key && (
              <div className="mx-2 mb-1 flex items-center justify-end gap-1 rounded-md bg-muted/50 px-2 py-1.5 text-[11px]">
                <span className="mr-auto text-muted-foreground">
                  {killing === key ? t('externalSessions.stopping') : t('externalSessions.stopScope')}
                </span>
                {killing !== key && (
                  <>
                    <button type="button" onClick={() => void stopSession(session, 'process')} className="font-medium text-red-500">
                      {t('externalSessions.agent')}
                    </button>
                    <button type="button" onClick={() => void stopSession(session, 'pane')} className="text-red-500">
                      pane
                    </button>
                    <button type="button" onClick={() => void stopSession(session, 'session')} className="text-red-500">
                      {t('externalSessions.session')}
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
