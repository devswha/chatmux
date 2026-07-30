import { useTranslation } from 'react-i18next';
import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import { Server, SquareTerminal, X } from 'lucide-react';

import type { ExternalTerminalTarget, Project } from '../../../../types/app';
import { api } from '../../../../utils/api';
import { isSameTmuxPaneTarget } from '../../../../utils/liveSessions';
import type { ExternalCliSession } from '../../hooks/useExternalCliSessions';
import SessionProviderLogo from '../../../llm-logo-provider/SessionProviderLogo';
import { tmuxPaneIdentityKey, type TmuxPaneTarget } from '../../../../../shared/tmux';

import SessionCompletionBell from './SessionCompletionBell';
import SessionActivityBadge, { type SessionActivityState } from './SessionActivityBadge';
import SortableSessionRow from './SortableSessionRow';

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
const isExternalSessionAuthoritative = (session: ExternalCliSession): boolean => (
  session.presence !== 'stale' && session.authority !== 'none'
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
  )) ?? null;
};

const canOpenExternalSession = (
  session: ExternalCliSession,
  project: Project | null,
): boolean => (
  isExternalSessionAuthoritative(session)
  && (
    Boolean(session.transcriptSessionId && project)
    || session.process !== null
    || Boolean(session.attachCapability)
  )
);
export type PendingExternalTranscriptTarget = TmuxPaneTarget;

type PendingTranscriptDisposition = 'ignore' | 'clear' | 'wait' | 'promote';

export function pendingExternalTranscriptDisposition(
  pending: PendingExternalTranscriptTarget | null,
  session: ExternalCliSession,
): PendingTranscriptDisposition {
  if (!pending || tmuxPaneIdentityKey(pending.tmux) !== tmuxPaneIdentityKey(session.tmux)) {
    return 'ignore';
  }
  if (
    !isExternalSessionAuthoritative(session)
    || session.process === null
    || !isSameTmuxPaneTarget(pending, { tmux: session.tmux, process: session.process })
  ) {
    return 'clear';
  }
  return session.transcriptSessionId ? 'promote' : 'wait';
}

function externalTargetKey(target: PendingExternalTranscriptTarget): string {
  return `${tmuxPaneIdentityKey(target.tmux)}\u0000${target.process.pid}\u0000${target.process.startedAtMs}`;
}

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
type SidebarExternalSessionRowProps = Omit<SidebarExternalSectionProps, 'sessions'> & {
  session: ExternalCliSession;
  sortId?: string;
  sortableDisabled?: boolean;
  pendingTranscriptRef: MutableRefObject<PendingExternalTranscriptTarget | null>;
};

export function SidebarExternalSessionRow({
  session,
  projects,
  onOpen,
  onChanged,
  pendingTranscriptRef,
  sortId,
  sortableDisabled = false,
}: SidebarExternalSessionRowProps) {
  const { t } = useTranslation('sidebar');
  const [confirming, setConfirming] = useState(false);
  const [killing, setKilling] = useState(false);
  const [error, setError] = useState('');

  const openSession = () => {
    const sessionProject = resolveExternalSessionProject(session, projects);
    if (!canOpenExternalSession(session, sessionProject)) return;
    pendingTranscriptRef.current = sessionProject
      && !isAttachOnlyKind(session.kind)
      && !session.transcriptSessionId
      && session.process
      ? { tmux: session.tmux, process: session.process }
      : null;
    onOpen({
      tmuxName: session.tmuxName,
      tmux: session.tmux,
      process: session.process,
      kind: KIND_LABEL[session.kind],
      cliKind: session.kind,
      project: sessionProject,
      projectPath: session.projectPath,
      transcriptSessionId: session.transcriptSessionId,
      sessionName: session.sessionName,
      model: session.model,
      effort: session.effort,
      transcriptEnded: session.transcriptEnded,
      attachCapability: session.attachCapability,
    });
  };

  const attachToApproval = () => {
    if (!isExternalSessionAuthoritative(session) || session.process === null) return;
    const sessionProject = resolveExternalSessionProject(session, projects);
    pendingTranscriptRef.current = null;
    onOpen({
      tmuxName: session.tmuxName,
      tmux: session.tmux,
      process: session.process,
      kind: KIND_LABEL[session.kind],
      cliKind: session.kind,
      project: sessionProject,
      projectPath: session.projectPath,
      transcriptSessionId: session.transcriptSessionId,
      sessionName: session.sessionName,
      model: session.model,
      effort: session.effort,
      transcriptEnded: session.transcriptEnded,
      attachCapability: session.attachCapability,
    }, { forceAttach: true });
  };

  const rowTargetKey = session.process === null
    ? null
    : externalTargetKey({ tmux: session.tmux, process: session.process });

  useEffect(() => {
    const disposition = pendingExternalTranscriptDisposition(
      pendingTranscriptRef.current,
      session,
    );
    if (disposition === 'clear') {
      pendingTranscriptRef.current = null;
      return;
    }
    if (disposition !== 'promote') return;
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
      projectPath: session.projectPath,
      transcriptSessionId: session.transcriptSessionId,
      sessionName: session.sessionName,
      model: session.model,
      effort: session.effort,
      transcriptEnded: session.transcriptEnded,
      attachCapability: session.attachCapability,
    });
  }, [onOpen, pendingTranscriptRef, projects, session]);

  useEffect(() => () => {
    const pending = pendingTranscriptRef.current;
    if (pending && rowTargetKey && externalTargetKey(pending) === rowTargetKey) {
      pendingTranscriptRef.current = null;
    }
  }, [pendingTranscriptRef, rowTargetKey]);

  const closeTmuxSession = async () => {
    if (killing || !isExternalSessionAuthoritative(session) || !session.process) return;
    setKilling(true);
    setError('');
    try {
      const response = await api.externalCliSessionKill(session.tmux, session.process, 'session');
      const body = await response.json().catch(() => null);
      if (response.ok && body?.data?.ok) {
        setConfirming(false);
        onChanged();
        return;
      }
      setError(body?.error?.message ?? body?.message ?? t('externalSessions.stopFailed'));
    } catch {
      setError(t('externalSessions.stopFailed'));
    } finally {
      setKilling(false);
    }
  };

  const canKill = (
    isExternalSessionAuthoritative(session)
    && !isAttachOnlyKind(session.kind)
    && session.process !== null
  );
  const activityState = sessionActivityState(session, canKill);
  const isInputRequired = activityState === 'input';
  const completionDescriptor = (
    isExternalSessionAuthoritative(session)
    && (session.kind === 'claude' || session.kind === 'codex' || session.kind === 'opencode' || session.kind === 'omp')
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
  const sessionProject = resolveExternalSessionProject(session, projects);
  const canOpen = canOpenExternalSession(session, sessionProject);
  const primary = session.tmuxName;
  const metadata = [
    sessionName,
    session.model?.split('/').pop(),
    session.effort ? `${session.effort} effort` : null,
    KIND_LABEL[session.kind],
  ].filter(Boolean).join(' · ');

  const content = (
    <>
      {isInputRequired && (
        <button
          type="button"
          onClick={attachToApproval}
          aria-label={t('externalSessions.activity.approvalPendingAttach', { name: session.tmuxName })}
          className="ml-1 mt-1.5 flex shrink-0 items-center gap-1.5 self-start rounded px-1 py-0.5 hover:bg-amber-500/10"
        >
          <SessionActivityBadge state="input" />
        </button>
      )}
      <button
        type="button"
        onClick={openSession}
        disabled={!canOpen}
        aria-disabled={!canOpen}
        title={session.transcriptSessionId
          ? `${primary} — ${metadata}`
          : isAttachOnlyKind(session.kind)
            ? t('externalSessions.viewInTerminal', { name: session.tmuxName })
            : t('externalSessions.openConversation', { name: primary })}
        className="flex min-w-0 flex-1 items-start gap-2 px-1.5 py-1.5 text-left disabled:cursor-not-allowed disabled:opacity-60"
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
    </>
  );
  const actions = (
    <>
      {completionDescriptor && (
        <SessionCompletionBell descriptor={completionDescriptor} className="m-1" />
      )}
      {canKill && (
        <button
          type="button"
          onClick={() => { setError(''); setConfirming(true); }}
          title={t('externalSessions.closeSessionTitle', { name: session.tmuxName })}
          aria-label={t('externalSessions.closeSessionTitle', { name: session.tmuxName })}
          className="m-1 rounded p-1.5 text-muted-foreground/60 transition-colors hover:bg-red-500/10 hover:text-red-500"
        >
          <X className="h-3.5 w-3.5" aria-hidden />
        </button>
      )}
    </>
  );
  const details = (
    <>
      {error && <p className="px-2 pb-1.5 pl-10 text-[11px] text-red-500">{error}</p>}
      {confirming && (
        <div className="mx-2 mb-1 flex items-center justify-end gap-1 rounded-md bg-muted/50 px-2 py-1.5 text-[11px]">
          <span className="mr-auto text-muted-foreground">
            {killing
              ? t('externalSessions.stopping')
              : t('externalSessions.closeSessionConfirm', { name: session.tmuxName })}
          </span>
          {!killing && (
            <>
              <button
                type="button"
                onClick={() => void closeTmuxSession()}
                className="rounded bg-red-600 px-2 py-0.5 font-medium text-white hover:bg-red-700"
              >
                {t('externalSessions.closeSession')}
              </button>
              <button type="button" onClick={() => setConfirming(false)} className="text-muted-foreground hover:text-foreground">
                {t('externalSessions.cancel')}
              </button>
            </>
          )}
        </div>
      )}
    </>
  );

  if (sortId) {
    return (
      <SortableSessionRow
        id={sortId}
        dragLabel={t('liveSessions.reorderSession', { name: primary })}
        disabled={sortableDisabled}
        content={content}
        actions={actions}
        details={details}
      />
    );
  }

  return (
    <div className="rounded-md transition-colors hover:bg-muted/50">
      <div className="flex items-start">
        {content}
        {actions}
      </div>
      {details}
    </div>
  );
}

export default function SidebarExternalSection({
  sessions,
  projects,
  onOpen,
  onChanged,
}: SidebarExternalSectionProps) {
  const pendingTranscriptRef = useRef<PendingExternalTranscriptTarget | null>(null);
  useEffect(() => () => {
    pendingTranscriptRef.current = null;
  }, []);
  if (sessions.length === 0) {
    return null;
  }

  return (
    <div className="space-y-0.5 px-1.5">
      {sessions.map((session) => (
        <SidebarExternalSessionRow
          key={tmuxPaneIdentityKey(session.tmux)}
          session={session}
          projects={projects}
          onOpen={onOpen}
          onChanged={onChanged}
          pendingTranscriptRef={pendingTranscriptRef}
        />
      ))}
    </div>
  );
}
