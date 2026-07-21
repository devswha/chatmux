import { useEffect, useState } from 'react';
import { X } from 'lucide-react';

import type { Project, ProjectSession } from '../../../../types/app';
import { cn } from '../../../../lib/utils';
import { api } from '../../../../utils/api';
import { getAllSessions, getSessionTime } from '../../utils/utils';

import type { SidebarProjectListProps } from './SidebarProjectList';
import SidebarIdleComposer from './SidebarIdleComposer';

type SidebarLiveSectionProps = {
  projects: Project[];
  liveSessionIds: ReadonlySet<string>;
  liveSessionNames: ReadonlyMap<string, string>;
  // Ids whose tmux name is a LINEAGE claim (gjc actually runs inside that tmux
  // session). cwd-fallback labels are display-only: offering kill there killed
  // an unrelated claude tmux session (patina 실사고).
  liveSessionLineage: ReadonlySet<string>;
  // `$N` tmux generation token per id — sent with kill so the server refuses a
  // same-named session recreated after this snapshot (409).
  liveSessionTmuxIds: ReadonlyMap<string, string>;
  // Foreground-command classification per id ('interactive' | 'batch'). A batch
  // gjc (a background/child gjc under a shell) is badged apart from an
  // interactive gjc TUI. Presentational only — kill/relay still key off lineage.
  liveSessionKinds: ReadonlyMap<string, string>;
  // Ids whose transcript tail shows a turn in progress — RUN (green) instead
  // of LIVE (blue). Presentational only.
  liveSessionRunning: ReadonlySet<string>;
  selectedSession: ProjectSession | null;
  onProjectSelect: SidebarProjectListProps['onProjectSelect'];
  onSessionSelect: SidebarProjectListProps['onSessionSelect'];
};

/** Per-row kill flow state (2-step confirm before the tower is asked to kill). */
type KillStatus =
  | { kind: 'idle' }
  | { kind: 'confirming' }
  | { kind: 'killing' }
  | { kind: 'error'; text: string };

/** Compact relative age for a session's last activity: <1m, Xm, Xhr, Xd, or ''. */
function formatAge(iso: string): string {
  const time = new Date(iso).getTime();
  if (!Number.isFinite(time) || time === 0) {
    return '';
  }
  const minutes = Math.floor(Math.max(0, Date.now() - time) / 60000);
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}hr`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * "작동 중" tab content: the live gjc fleet. Each row is labelled by its TMUX
 * session name (omg/stock/flask/…) as the primary label — this is a fleet roster,
 * not a conversation list — with the project name + recent activity underneath and
 * the conversation title in the tooltip. Falls back to the conversation title when
 * the tmux name is unknown. Renders nothing when nothing is live.
 *
 * Rows with a known tmux name get a close (✕) control: 2-step confirm, then the
 * server proxies the control tower's /kill (the tower is the fleet-lifecycle
 * authority — protected sessions are refused there with 403).
 */
export default function SidebarLiveSection({
  projects,
  liveSessionIds,
  liveSessionNames,
  liveSessionLineage,
  liveSessionTmuxIds,
  liveSessionKinds,
  liveSessionRunning,
  selectedSession,
  onProjectSelect,
  onSessionSelect,
}: SidebarLiveSectionProps) {
  // Session ids killed in this component instance — hidden immediately; the 5s
  // live poll is the source of truth and will drop them for real.
  const [killedIds, setKilledIds] = useState<ReadonlySet<string>>(new Set());
  const [killStatus, setKillStatus] = useState<Map<string, KillStatus>>(new Map());
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [openError, setOpenError] = useState<Map<string, string>>(new Map());

  // Reconcile row-local state with each authoritative snapshot (리뷰 반영):
  // ids the poll no longer reports drop their killed/confirm/error state, so a
  // later id reuse (e.g. idle-gjc:<name> after a new gjc boots there) renders
  // fresh instead of staying hidden or showing a stale confirm strip.
  useEffect(() => {
    setKilledIds((prev) => {
      const next = new Set([...prev].filter((id) => liveSessionIds.has(id)));
      return next.size === prev.size ? prev : next;
    });
    setKillStatus((prev) => {
      const next = new Map([...prev].filter(([id]) => liveSessionIds.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [liveSessionIds]);

  if (liveSessionIds.size === 0) {
    return null;
  }

  const rows = projects.flatMap((project) =>
    getAllSessions(project)
      .filter((session) => liveSessionIds.has(session.id) && !killedIds.has(session.id))
      .map((session) => ({ project, session })),
  );

  // Live ids whose session isn't in any *loaded* project page (pagination) still
  // deserve a row — otherwise whole live sessions silently vanish from the tab
  // (하코 관찰: horcrux/patina 라이브가 안 보임). They render with the tmux name
  // (or a placeholder) and keep the kill control; selection needs the loaded
  // session object, so they are not clickable until the session list loads them.
  const matchedIds = new Set(rows.map(({ session }) => session.id));
  const orphans = [...liveSessionIds].filter((id) => !matchedIds.has(id) && !killedIds.has(id));

  if (rows.length === 0 && orphans.length === 0) {
    return null;
  }

  const statusOf = (id: string): KillStatus => killStatus.get(id) ?? { kind: 'idle' };
  const setStatusOf = (id: string, status: KillStatus) => {
    setKillStatus((prev) => {
      const next = new Map(prev);
      if (status.kind === 'idle') {
        next.delete(id);
      } else {
        next.set(id, status);
      }
      return next;
    });
  };

  const openOrphan = async (sessionId: string) => {
    if (openingId) return;
    setOpeningId(sessionId);
    setOpenError((previous) => {
      const next = new Map(previous);
      next.delete(sessionId);
      return next;
    });
    try {
      const response = await api.sessionDetails(sessionId);
      const body = await response.json().catch(() => null);
      const session = body?.data?.session as {
        sessionId?: unknown;
        provider?: unknown;
        summary?: unknown;
        projectId?: unknown;
        createdAt?: unknown;
        updatedAt?: unknown;
      } | undefined;
      if (!response.ok || session?.sessionId !== sessionId || session.provider !== 'gjc') {
        throw new Error(body?.error?.message ?? '이전 대화를 불러오지 못했습니다');
      }
      const projectId = typeof session.projectId === 'string' ? session.projectId : '';
      const project = projects.find((candidate) => candidate.projectId === projectId);
      if (!project) {
        throw new Error('연결된 프로젝트를 찾지 못했습니다. 목록을 새로고침해 주세요.');
      }
      onProjectSelect(project);
      onSessionSelect({
        id: sessionId,
        summary: typeof session.summary === 'string' ? session.summary : '',
        createdAt: typeof session.createdAt === 'string' ? session.createdAt : undefined,
        updated_at: typeof session.updatedAt === 'string' ? session.updatedAt : undefined,
        __provider: 'gjc',
      }, project.projectId);
    } catch (error) {
      setOpenError((previous) => new Map(previous).set(
        sessionId,
        error instanceof Error ? error.message : '이전 대화를 불러오지 못했습니다',
      ));
    } finally {
      setOpeningId(null);
    }
  };

  const kill = async (sessionId: string, tmuxName: string) => {
    setStatusOf(sessionId, { kind: 'killing' });
    try {
      const response = await api.liveSessionKill(tmuxName, liveSessionTmuxIds.get(sessionId) ?? null);
      const body = await response.json().catch(() => null);
      const data = (body?.data ?? body ?? {}) as {
        ok?: boolean;
        reachable?: boolean;
        protected?: boolean;
        unknown?: boolean;
        detail?: string;
      };
      if (response.ok && data.ok) {
        setStatusOf(sessionId, { kind: 'idle' });
        setKilledIds((prev) => new Set([...prev, sessionId]));
        return;
      }
      const text = data.reachable === false
        ? '관제탑 미가동 — 종료 불가'
        : response.status === 409
          ? '대상이 교체됨 — 같은 이름의 다른 세션 (목록 갱신 후 재시도)'
          : data.protected
            ? '보호 세션 — 관제탑에서 수동으로만'
            : data.unknown
              ? '세션을 찾지 못함 (이미 종료됐을 수 있음)'
              : (typeof body?.error === 'string' && body.error) || data.detail || '세션 종료 실패';
      setStatusOf(sessionId, { kind: 'error', text });
    } catch {
      setStatusOf(sessionId, { kind: 'error', text: '세션 종료 실패' });
    }
  };

  // Shared kill affordances (matched rows + orphan rows use the same flow).
  const killButton = (id: string, tmuxName: string) =>
    statusOf(id).kind === 'idle' ? (
      <button
        type="button"
        title={`tmux 세션 ${tmuxName} 닫기`}
        onClick={() => setStatusOf(id, { kind: 'confirming' })}
        className="mr-1 mt-1.5 rounded p-1 text-muted-foreground/60 transition-colors hover:bg-red-500/10 hover:text-red-500"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    ) : null;

  const killStrip = (id: string, tmuxName: string) => {
    const status = statusOf(id);
    if (status.kind === 'idle') {
      return null;
    }
    return (
      <div className="px-2 pb-1.5 pl-[1.375rem]">
        {status.kind === 'error' ? (
          <p className="flex items-center justify-between gap-2 text-[11px] text-red-500">
            <span className="truncate">{status.text}</span>
            <button
              type="button"
              onClick={() => setStatusOf(id, { kind: 'idle' })}
              className="shrink-0 text-muted-foreground hover:text-foreground"
            >
              닫기
            </button>
          </p>
        ) : (
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-[11px] text-muted-foreground">
              {status.kind === 'killing' ? '종료 중…' : `tmux 세션 '${tmuxName}' 종료?`}
            </span>
            {status.kind === 'confirming' && (
              <span className="flex shrink-0 items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => void kill(id, tmuxName)}
                  className="rounded bg-red-600 px-2 py-0.5 text-[11px] font-medium text-white transition-colors hover:bg-red-700"
                >
                  종료
                </button>
                <button
                  type="button"
                  onClick={() => setStatusOf(id, { kind: 'idle' })}
                  className="rounded px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
                >
                  취소
                </button>
              </span>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="px-2 py-2">
      <div className="space-y-0.5">
        {rows.map(({ project, session }) => {
          const isSelected = selectedSession?.id === session.id;
          const title = session.summary || session.name || 'Session';
          const tmuxName = liveSessionNames.get(session.id);
          const primary = tmuxName ?? title;
          const age = formatAge(getSessionTime(session));
          return (
            <div
              key={session.id}
              className={cn(
                'rounded-md transition-colors hover:bg-muted/50',
                isSelected && 'bg-primary/5',
              )}
            >
              <div className="flex items-start">
                <button
                  type="button"
                  title={title}
                  onClick={() => onSessionSelect(session, project.projectId)}
                  className="flex min-w-0 flex-1 flex-col gap-0.5 px-2 py-1.5 text-left"
                >
                  <span className="flex items-center gap-2">
                    {liveSessionRunning.has(session.id) ? (
                      <>
                        <span className="inline-flex h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-emerald-500" aria-hidden />
                        <span
                          className="shrink-0 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-600 dark:text-emerald-400"
                          title="턴 진행 중 — 에이전트가 응답/도구 실행 중입니다"
                        >
                          RUN
                        </span>
                      </>
                    ) : (
                      <>
                        <span className="inline-flex h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-blue-500" aria-hidden />
                        <span
                          className="shrink-0 rounded bg-blue-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-blue-600 dark:text-blue-400"
                          title="세션 감지됨 — 다음 지시 대기 중"
                        >
                          LIVE
                        </span>
                      </>
                    )}
                    {liveSessionKinds.get(session.id) === 'batch' && (
                      <span
                        className="shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-600 dark:text-amber-400"
                        title="이 tmux pane의 전면 명령이 gjc가 아닙니다 — gjc는 배치(백그라운드) 자손으로 실행 중"
                      >
                        배치
                      </span>
                    )}
                    <span className="truncate text-sm font-medium text-foreground">{primary}</span>
                  </span>
                  <span className="truncate pl-[1.375rem] text-[11px] text-muted-foreground">
                    {project.displayName}{age ? ` · ${age}` : ''}
                  </span>
                </button>
                {tmuxName && liveSessionLineage.has(session.id) && killButton(session.id, tmuxName)}
              </div>
              {tmuxName && liveSessionLineage.has(session.id) && killStrip(session.id, tmuxName)}
            </div>
          );
        })}
        {orphans.map((id) => {
          const tmuxName = liveSessionNames.get(id);
          // Server-synthetic row: a gjc TUI runs in this tmux session but has no
          // transcript yet (gjc creates it at the FIRST message) — waiting, not live.
          const isIdle = id.startsWith('idle-gjc:');
          const content = (
            <>
              <span className="flex items-center gap-2">
                <span
                  className={`inline-flex h-1.5 w-1.5 shrink-0 rounded-full ${isIdle ? 'bg-muted-foreground/50' : liveSessionRunning.has(id) ? 'animate-pulse bg-emerald-500' : 'animate-pulse bg-blue-500'}`}
                  aria-hidden
                />
                <span
                  className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold ${isIdle ? 'bg-muted text-muted-foreground' : liveSessionRunning.has(id) ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' : 'bg-blue-500/15 text-blue-600 dark:text-blue-400'}`}
                >
                  {isIdle ? '대기' : liveSessionRunning.has(id) ? 'RUN' : 'LIVE'}
                </span>
                {liveSessionKinds.get(id) === 'batch' && (
                  <span
                    className="shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-600 dark:text-amber-400"
                    title="이 tmux pane의 전면 명령이 gjc가 아닙니다 — gjc는 배치(백그라운드) 자손으로 실행 중"
                  >
                    배치
                  </span>
                )}
                <span className="truncate text-sm font-medium text-foreground">
                  {tmuxName ?? '이름 미확인 세션'}
                </span>
              </span>
              <span className="truncate pl-[1.375rem] text-[11px] text-muted-foreground">
                {isIdle
                  ? '아직 대화가 없습니다 — 아래에서 첫 메시지를 보낼 수 있습니다'
                  : openingId === id
                    ? '이전 대화 불러오는 중…'
                    : '눌러서 이전 대화 열기'}
              </span>
            </>
          );
          return (
            <div key={id} className="rounded-md transition-colors hover:bg-muted/50">
              <div className="flex items-start">
                {isIdle ? (
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5 px-2 py-1.5 text-left">{content}</div>
                ) : (
                  <button
                    type="button"
                    disabled={openingId !== null}
                    onClick={() => void openOrphan(id)}
                    className="flex min-w-0 flex-1 flex-col gap-0.5 px-2 py-1.5 text-left disabled:opacity-60"
                  >
                    {content}
                  </button>
                )}
                {tmuxName && liveSessionLineage.has(id) && killButton(id, tmuxName)}
              </div>
              {openError.has(id) && (
                <p className="px-2 pb-1.5 pl-[1.375rem] text-[11px] text-red-500">{openError.get(id)}</p>
              )}
              {isIdle && tmuxName && liveSessionLineage.has(id) && (
                <SidebarIdleComposer
                  key={`composer-${id}`}
                  tmuxName={tmuxName}
                  tmuxId={liveSessionTmuxIds.get(id) ?? null}
                />
              )}
              {tmuxName && liveSessionLineage.has(id) && killStrip(id, tmuxName)}
            </div>
          );
        })}
      </div>
      <p className="px-2 pt-2 text-[10px] leading-relaxed text-muted-foreground/70">
        tmux 안에서 도는 gjc 세션만 감지됩니다 — claude 등 다른 CLI 세션은 표시되지 않습니다.
      </p>
    </div>
  );
}
