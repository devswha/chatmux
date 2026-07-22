import { Fragment, useEffect, useRef, useState } from 'react';
import { MessageSquare, Server, SquareTerminal, X } from 'lucide-react';

import type { ExternalTerminalTarget, Project } from '../../../../types/app';
import { api } from '../../../../utils/api';
import type { ExternalCliSession } from '../../hooks/useExternalCliSessions';
import SessionProviderLogo from '../../../llm-logo-provider/SessionProviderLogo';

const KIND_LABEL: Record<ExternalCliSession['kind'], string> = {
  claude: 'Claude Code',
  codex: 'Codex CLI',
  ssh: 'ssh (원격)',
};

// codex/claude tmux sessions can be stopped from the list; ssh sessions are not
// ours to kill.

type SidebarExternalSectionProps = {
  sessions: ExternalCliSession[];
  projects: Project[];
  /** Opens the session as a full main-area terminal (like gjc sessions do). */
  onOpen: (target: ExternalTerminalTarget) => void;
  onChanged: () => void;
};

/**
 * External CLI rows (claude/codex/ssh tmux sessions, from useExternalCliSessions)
 * for the unified sessions list. A row click hands the target to the app shell,
 * which renders it as a full main-area terminal (Termius-style attach) —
 * mirroring how gjc sessions fill the right side. Returns null when empty; the
 * unified section owns the combined empty state.
 */
export default function SidebarExternalSection({ sessions, projects, onOpen, onChanged }: SidebarExternalSectionProps) {
  const [confirming, setConfirming] = useState<string | null>(null);
  const [killing, setKilling] = useState<string | null>(null);
  const [error, setError] = useState('');
  const pendingTranscriptRef = useRef<string | null>(null);
  // Shell needs a real project only for the PTY cwd; attach ignores the cwd.
  const shellProject = projects[0] ?? null;

  const openSession = (session: ExternalCliSession) => {
    if (!shellProject) return;
    pendingTranscriptRef.current = session.kind === 'codex' && !session.transcriptSessionId
      ? session.tmuxName
      : null;
    onOpen({
      tmuxName: session.tmuxName,
      kind: KIND_LABEL[session.kind],
      cliKind: session.kind,
      project: shellProject,
      transcriptSessionId: session.transcriptSessionId,
    });
  };

  useEffect(() => {
    const tmuxName = pendingTranscriptRef.current;
    if (!tmuxName || !shellProject) return;
    const session = sessions.find((candidate) => (
      candidate.tmuxName === tmuxName && candidate.transcriptSessionId
    ));
    if (!session) return;
    pendingTranscriptRef.current = null;
    onOpen({
      tmuxName: session.tmuxName,
      kind: KIND_LABEL[session.kind],
      cliKind: session.kind,
      project: shellProject,
      transcriptSessionId: session.transcriptSessionId,
    });
  }, [onOpen, sessions, shellProject]);

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
        const canKill = session.kind === 'codex' || session.kind === 'claude';
        return (
          <Fragment key={session.tmuxName}>
            <div className="flex items-start rounded-md transition-colors hover:bg-muted/50">
              <button
                type="button"
                onClick={() => openSession(session)}
                title={session.transcriptSessionId
                  ? `tmux 세션 '${session.tmuxName}' ${KIND_LABEL[session.kind]} transcript로 보기`
                  : `tmux 세션 '${session.tmuxName}' 터미널로 보기`}
                className="flex min-w-0 flex-1 items-start gap-2 px-2 py-1.5 text-left"
              >
                {session.kind === 'ssh' ? (
                  <Server className="mt-0.5 h-4 w-4 flex-shrink-0 text-slate-400" aria-hidden />
                ) : (
                  <SessionProviderLogo provider={session.kind} className="mt-0.5 h-4 w-4 flex-shrink-0" />
                )}
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-foreground">{session.tmuxName}</span>
                  </span>
                  <span className="truncate text-[11px] text-muted-foreground">
                    {KIND_LABEL[session.kind]}{session.transcriptSessionId ? ' · Transcript' : ''}
                  </span>
                </span>
                {session.transcriptSessionId ? (
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
