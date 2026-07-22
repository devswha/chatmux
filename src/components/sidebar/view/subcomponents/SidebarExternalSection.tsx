import { Fragment, useEffect, useRef, useState } from 'react';
import { MessageSquare, Server, SquareTerminal, X } from 'lucide-react';

import type { ExternalTerminalTarget, Project } from '../../../../types/app';
import { api } from '../../../../utils/api';
import type { ExternalCliSession, ExternalSessionActivity } from '../../hooks/useExternalCliSessions';
import SessionProviderLogo from '../../../llm-logo-provider/SessionProviderLogo';

const KIND_LABEL: Record<ExternalCliSession['kind'], string> = {
  claude: 'Claude Code',
  codex: 'Codex CLI',
  cursor: 'Cursor',
  opencode: 'OpenCode',
  omp: 'Oh My Pi',
  ssh: 'ssh (원격)',
};

const ACTIVITY_BADGE: Record<ExternalSessionActivity, {
  label: string;
  title: string;
  className: string;
  dotClassName: string;
}> = {
  running: {
    label: 'RUN',
    title: '에이전트가 응답하거나 도구를 실행 중입니다',
    className: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
    dotClassName: 'animate-pulse bg-emerald-500',
  },
  waiting_user: {
    label: '대기',
    title: '현재 턴이 끝나 다음 사용자 입력을 기다립니다',
    className: 'bg-blue-500/15 text-blue-600 dark:text-blue-400',
    dotClassName: 'bg-blue-500',
  },
  asking_user: {
    label: '질문',
    title: '에이전트가 현재 턴에서 사용자 선택이나 승인을 기다립니다',
    className: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
    dotClassName: 'animate-pulse bg-amber-500',
  },
  unknown: {
    label: '확인 불가',
    title: 'provider 기록에서 현재 상태를 안전하게 판정할 수 없습니다',
    className: 'bg-muted text-muted-foreground',
    dotClassName: 'bg-muted-foreground/50',
  },
};

// Local coding-agent tmux sessions can be stopped; remote SSH sessions are not
// ours to kill.

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
  onOpen: (target: ExternalTerminalTarget) => void;
  onChanged: () => void;
};

/**
 * Local coding-agent and remote SSH tmux rows for the unified sessions list.
 * Local agents open structured transcripts when indexed and use terminal
 * attach before then. SSH is always attach-only because its process and
 * transcript are not locally observable.
 */
export default function SidebarExternalSection({ sessions, projects, onOpen, onChanged }: SidebarExternalSectionProps) {
  const [confirming, setConfirming] = useState<string | null>(null);
  const [killing, setKilling] = useState<string | null>(null);
  const [error, setError] = useState('');
  const pendingTranscriptRef = useRef<string | null>(null);
  // SSH attach only needs any project-shaped shell context. Local transcripts
  // must use their owning project so the selected session can actually render.
  const shellProject = projects[0] ?? null;

  const openSession = (session: ExternalCliSession) => {
    const sessionProject = resolveExternalSessionProject(session, projects);
    if (!sessionProject) return;
    pendingTranscriptRef.current = session.kind !== 'ssh' && !session.transcriptSessionId
      ? session.tmuxName
      : null;
    onOpen({
      tmuxName: session.tmuxName,
      kind: KIND_LABEL[session.kind],
      cliKind: session.kind,
      project: sessionProject,
      transcriptSessionId: session.transcriptSessionId,
      sessionName: session.sessionName,
      model: session.model,
    });
  };

  useEffect(() => {
    const tmuxName = pendingTranscriptRef.current;
    if (!tmuxName) return;
    const session = sessions.find((candidate) => (
      candidate.tmuxName === tmuxName && candidate.transcriptSessionId
    ));
    if (!session) return;
    const sessionProject = resolveExternalSessionProject(session, projects);
    if (!sessionProject) return;
    pendingTranscriptRef.current = null;
    onOpen({
      tmuxName: session.tmuxName,
      kind: KIND_LABEL[session.kind],
      cliKind: session.kind,
      project: sessionProject,
      transcriptSessionId: session.transcriptSessionId,
      sessionName: session.sessionName,
      model: session.model,
    });
  }, [onOpen, sessions, projects]);

  const stopSession = async (tmuxName: string) => {
    if (killing) return;
    setKilling(tmuxName);
    setError('');
    try {
      const response = await api.externalCliSessionKill(tmuxName);
      const body = await response.json().catch(() => null);
      if (response.ok && body?.data?.ok) {
        setConfirming(null);
        onChanged();
        return;
      }
      setError(body?.error?.message ?? body?.message ?? '세션 종료 실패');
    } catch {
      setError('세션 종료 실패');
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
        const canKill = session.kind !== 'ssh';
        const activityBadge = canKill ? ACTIVITY_BADGE[session.activity ?? 'unknown'] : null;
        const sessionName = session.sessionName?.trim();
        const primary = sessionName || session.tmuxName;
        const metadata = [
          session.model?.split('/').pop(),
          sessionName ? session.tmuxName : null,
          KIND_LABEL[session.kind],
        ].filter(Boolean).join(' · ');
        return (
          <Fragment key={session.tmuxName}>
            <div className="flex items-start rounded-md transition-colors hover:bg-muted/50">
              <button
                type="button"
                onClick={() => openSession(session)}
                title={session.transcriptSessionId
                  ? `${primary} — ${metadata}`
                  : session.kind === 'ssh'
                    ? `tmux 세션 '${session.tmuxName}' 터미널로 보기`
                    : `${primary} — 대화 열기`}
                className="flex min-w-0 flex-1 items-start gap-2 px-2 py-1.5 text-left"
              >
                {session.kind === 'ssh' ? (
                  <Server className="mt-0.5 h-4 w-4 flex-shrink-0 text-slate-400" aria-hidden />
                ) : (
                  <SessionProviderLogo provider={session.kind} className="mt-0.5 h-4 w-4 flex-shrink-0" />
                )}
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="flex items-center gap-2">
                    {activityBadge && (
                      <>
                        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${activityBadge.dotClassName}`} aria-hidden />
                        <span
                          className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold ${activityBadge.className}`}
                          title={activityBadge.title}
                          aria-label={activityBadge.title}
                        >
                          {activityBadge.label}
                        </span>
                      </>
                    )}
                    <span className="truncate text-sm font-medium text-foreground">{primary}</span>
                  </span>
                  <span className="truncate text-[11px] text-muted-foreground">
                    {metadata}
                  </span>
                </span>
                {session.kind !== 'ssh' ? (
                  <MessageSquare className="mt-1 h-3.5 w-3.5 shrink-0 text-emerald-500" aria-hidden />
                ) : (
                  <SquareTerminal className="mt-1 h-3.5 w-3.5 shrink-0 text-muted-foreground/60" aria-hidden />
                )}
              </button>
              {canKill && (
                <button
                  type="button"
                  onClick={() => { setError(''); setConfirming(session.tmuxName); }}
                  title={`tmux 세션 '${session.tmuxName}' 종료`}
                  aria-label={`${session.tmuxName} 종료`}
                  className="m-1 rounded p-1.5 text-muted-foreground/60 transition-colors hover:bg-red-500/10 hover:text-red-500"
                >
                  <X className="h-3.5 w-3.5" aria-hidden />
                </button>
              )}
            </div>
            {confirming === session.tmuxName && (
              <div className="mx-2 mb-1 flex items-center justify-end gap-2 rounded-md bg-muted/50 px-2 py-1.5 text-[11px]">
                <span className="mr-auto text-muted-foreground">이 세션을 종료할까요?</span>
                <button type="button" onClick={() => setConfirming(null)} className="text-muted-foreground hover:text-foreground">
                  취소
                </button>
                <button
                  type="button"
                  onClick={() => void stopSession(session.tmuxName)}
                  disabled={killing === session.tmuxName}
                  className="font-medium text-red-500 disabled:opacity-50"
                >
                  {killing === session.tmuxName ? '종료 중…' : '종료'}
                </button>
              </div>
            )}
          </Fragment>
        );
      })}
    </div>
  );
}
