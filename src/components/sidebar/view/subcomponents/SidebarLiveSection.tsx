import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  sortableKeyboardCoordinates,
  SortableContext,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, X } from 'lucide-react';

import type { ExternalTerminalTarget, Project, ProjectSession } from '../../../../types/app';
import {
  applySessionOrder,
  createSessionOrderId,
  mergeVisibleSessionOrder,
  migrateSessionOrderAliases,
  moveSession,
  persistSessionOrder,
  readStoredSessionOrder,
} from '../../utils/sessionOrder';
import { api } from '../../../../utils/api';
import { getAllSessions, getSessionTime } from '../../utils/utils';
import SessionProviderLogo from '../../../llm-logo-provider/SessionProviderLogo';
import type { TmuxPaneIdentity, TmuxPaneTarget } from '../../../../../shared/tmux';
import type { ExternalCliSession } from '../../hooks/useExternalCliSessions';
import { tmuxPaneIdentityKey } from '../../../../../shared/tmux';
import type { ProviderConnectionIssue } from '../../../../../shared/provider-connection';

import SessionCompletionBell from './SessionCompletionBell';
import SessionActivityBadge from './SessionActivityBadge';
import SortableSessionRow from './SortableSessionRow';
import {
  SidebarExternalSessionRow,
  type PendingExternalTranscriptTarget,
} from './SidebarExternalSection';

type SidebarLiveSectionProps = {
  projects: Project[];
  liveSessionIds: ReadonlySet<string>;
  externalSessions?: ExternalCliSession[];
  liveSessionNames: ReadonlyMap<string, string>;
  liveSessionModels?: ReadonlyMap<string, string>;
  liveSessionEfforts?: ReadonlyMap<string, string>;
  // Ids whose tmux name is a LINEAGE claim (gjc runs inside that tmux session).
  // Cwd-fallback labels are display-only and must never enable kill or relay.
  liveSessionLineage: ReadonlySet<string>;
  // Exact pane and agent-process generation per actionable row.
  liveSessionPanes?: ReadonlyMap<string, TmuxPaneIdentity>;
  liveSessionPresence?: ReadonlyMap<string, 'present' | 'stale'>;
  liveSessionTargets: ReadonlyMap<string, TmuxPaneTarget>;
  // Foreground-command classification per id ('interactive' | 'batch'). A batch
  // gjc (a background/child gjc under a shell) is badged apart from an
  // interactive gjc TUI. Presentational only — kill/relay still key off lineage.
  liveSessionKinds: ReadonlyMap<string, string>;
  // Ids whose transcript tail shows a turn in progress — RUN (green) instead
  // of READY (blue). Presentational only.
  liveSessionRunning: ReadonlySet<string>;
  liveSessionInput?: ReadonlySet<string>;
  liveSessionErrors?: ReadonlySet<string>;
  liveSessionConnectionIssues?: ReadonlyMap<string, ProviderConnectionIssue>;
  selectedSession: ProjectSession | null;
  onProjectSelect: (project: Project) => void;
  onSessionSelect: (session: ProjectSession, projectId: string) => void;
  onExternalSessionsChanged?: () => void;
  onExternalTerminalOpen?: (
    target: ExternalTerminalTarget,
    options?: { forceAttach?: boolean },
  ) => void;
};

const EMPTY_SESSION_METADATA = new Map<string, string>();
const EMPTY_SESSION_PANES = new Map<string, TmuxPaneIdentity>();
const EMPTY_SESSION_PRESENCE = new Map<string, 'present' | 'stale'>();
const NOOP_EXTERNAL_OPEN = () => {};
const NOOP_EXTERNAL_CHANGED = () => {};
const EMPTY_SESSION_IDS = new Set<string>();
const isStableGjcSessionId = (sessionId: string) => (
  sessionId.length > 0 && !sessionId.startsWith('idle-gjc:')
);
const sessionOrderId = (
  sessionId: string,
  panes: ReadonlyMap<string, TmuxPaneIdentity>,
  targets: ReadonlyMap<string, TmuxPaneTarget>,
): string => createSessionOrderId(sessionId, panes.get(sessionId) ?? targets.get(sessionId)?.tmux);

/** Per-row whole-session close state with a destructive-action confirmation. */
type CloseStatus =
  | { kind: 'idle' }
  | { kind: 'confirming' }
  | { kind: 'stopping' }
  | { kind: 'error'; text: string };

type LiveSessionRow =
  | { kind: 'matched'; id: string; sortId: string; presence: 'present' | 'stale'; project: Project; session: ProjectSession }
  | { kind: 'orphan'; id: string; sortId: string; presence: 'present' | 'stale' }
  | { kind: 'external'; id: string; sortId: string; session: ExternalCliSession };

const rowPresence = (row: LiveSessionRow): 'present' | 'stale' => (
  row.kind === 'external'
    ? row.session.authority === 'none' ? 'stale' : (row.session.presence ?? 'present')
    : row.presence
);

const preferSessionRow = (
  left: LiveSessionRow,
  right: LiveSessionRow,
  liveTargets: ReadonlyMap<string, TmuxPaneTarget>,
): LiveSessionRow => {
  const leftPresence = rowPresence(left);
  const rightPresence = rowPresence(right);
  if (leftPresence !== rightPresence) return leftPresence === 'present' ? left : right;

  const leftProcess = left.kind === 'external' ? left.session.process : liveTargets.get(left.id)?.process ?? null;
  const rightProcess = right.kind === 'external' ? right.session.process : liveTargets.get(right.id)?.process ?? null;
  if (leftPresence === 'present') {
    if (leftProcess && rightProcess) {
      if (leftProcess.startedAtMs !== rightProcess.startedAtMs) {
        return leftProcess.startedAtMs > rightProcess.startedAtMs ? left : right;
      }
      if (leftProcess.pid !== rightProcess.pid) return leftProcess.pid > rightProcess.pid ? left : right;
    } else if (Boolean(leftProcess) !== Boolean(rightProcess)) {
      return leftProcess ? left : right;
    }
  }

  if (left.kind === 'external' && right.kind !== 'external') return right;
  if (right.kind === 'external' && left.kind !== 'external') return left;
  return left;
};

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
 * "작동 중" tab content: the live GJC tmux fleet. Each row is labelled by its
 * tmux session name (omg/stock/flask/…) as the primary label — this is a fleet
 * roster, not a conversation list — with the project name + recent activity
 * underneath and the conversation title in the tooltip. Non-tmux processes
 * remain available through transcript history but do not appear in this roster.
 *
 * Rows with a known tmux name get a close (✕) control: 2-step confirm, then the
 * server proxies the control tower's /kill (the tower is the fleet-lifecycle
 * authority — protected sessions are refused there with 403).
 */
export default function SidebarLiveSection({
  projects,
  liveSessionIds,
  externalSessions = [],
  liveSessionNames,
  liveSessionModels = EMPTY_SESSION_METADATA,
  liveSessionEfforts = EMPTY_SESSION_METADATA,
  liveSessionLineage,
  liveSessionTargets,
  liveSessionPanes = EMPTY_SESSION_PANES,
  liveSessionPresence = EMPTY_SESSION_PRESENCE,
  liveSessionKinds,
  liveSessionRunning,
  liveSessionInput = EMPTY_SESSION_IDS,
  liveSessionErrors = EMPTY_SESSION_IDS,
  liveSessionConnectionIssues = new Map(),
  selectedSession,
  onProjectSelect,
  onSessionSelect,
  onExternalTerminalOpen,
  onExternalSessionsChanged,
}: SidebarLiveSectionProps) {
  const { t } = useTranslation('sidebar');
  // Session ids closed in this component instance are hidden immediately; the
  // live poll remains the source of truth and removes them authoritatively.
  const [closedIds, setClosedIds] = useState<ReadonlySet<string>>(new Set());
  const [closeStatus, setCloseStatus] = useState<Map<string, CloseStatus>>(new Map());
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [openError, setOpenError] = useState<Map<string, string>>(new Map());
  const pendingExternalTranscriptRef = useRef<PendingExternalTranscriptTarget | null>(null);
  const [sessionOrder, setSessionOrder] = useState<string[]>(readStoredSessionOrder);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // Reconcile row-local state with each authoritative snapshot:
  // ids the poll no longer reports drop their close/confirm/error state, so a
  // later id reuse (e.g. idle-gjc:<name> after a new gjc boots there) renders
  // fresh instead of staying hidden or showing a stale confirm strip.
  useEffect(() => {
    setClosedIds((prev) => {
      const next = new Set([...prev].filter((id) => liveSessionIds.has(id)));
      return next.size === prev.size ? prev : next;
    });
    setCloseStatus((prev) => {
      const next = new Map([...prev].filter(([id]) => liveSessionIds.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [liveSessionIds]);

  const matchedRows = projects.flatMap((project) =>
    getAllSessions(project)
      .filter((session) => liveSessionIds.has(session.id) && liveSessionNames.has(session.id) && !closedIds.has(session.id))
      .map((session) => ({ project, session })),
  );

  // Live tmux ids whose session isn't in any *loaded* project page (pagination)
  // still deserve a row — otherwise whole tmux sessions silently vanish from
  // the tab. Transcript-only processes without a tmux name stay in history.
  const matchedIds = new Set(matchedRows.map(({ session }) => session.id));
  const orphanIds = [...liveSessionIds].filter((id) => (
    liveSessionNames.has(id) && !matchedIds.has(id) && !closedIds.has(id)
  ));
  const gjcRows: LiveSessionRow[] = [
    ...matchedRows.map(({ project, session }) => ({
      kind: 'matched' as const,
      id: session.id,
      sortId: sessionOrderId(session.id, liveSessionPanes, liveSessionTargets),
      presence: liveSessionPresence.get(session.id) ?? 'present',
      project,
      session,
    })),
    ...orphanIds.map((id) => ({
      kind: 'orphan' as const,
      id,
      sortId: sessionOrderId(id, liveSessionPanes, liveSessionTargets),
      presence: liveSessionPresence.get(id) ?? 'present',
    })),
  ];
  const aliasSignature = JSON.stringify(gjcRows.flatMap((row) => {
    const tmux = liveSessionPanes.get(row.id) ?? liveSessionTargets.get(row.id)?.tmux;
    if (!tmux) return [];
    return [[createSessionOrderId(row.id), createSessionOrderId(row.id, tmux)]];
  }));
  const orderAliases = useMemo(
    () => new Map<string, string>(JSON.parse(aliasSignature) as Array<[string, string]>),
    [aliasSignature],
  );
  const reconciledSessionOrder = migrateSessionOrderAliases(sessionOrder, orderAliases);

  useEffect(() => {
    setSessionOrder((currentOrder) => {
      const migratedOrder = migrateSessionOrderAliases(currentOrder, orderAliases);
      if (
        migratedOrder.length === currentOrder.length
        && migratedOrder.every((id, index) => id === currentOrder[index])
      ) {
        return currentOrder;
      }
      persistSessionOrder(migratedOrder);
      return migratedOrder;
    });
  }, [orderAliases]);

  // During provider handoff/poll overlap, reconcile the same pane from comparable
  // presence and process-generation evidence. Provider kind only breaks a true tie.
  const deduplicatedByPane = new Map<string, LiveSessionRow>();
  for (const candidate of [
    ...gjcRows,
    ...externalSessions.map((session): LiveSessionRow => ({
      kind: 'external',
      id: tmuxPaneIdentityKey(session.tmux),
      sortId: createSessionOrderId('', session.tmux),
      session,
    })),
  ]) {
    const current = deduplicatedByPane.get(candidate.sortId);
    deduplicatedByPane.set(
      candidate.sortId,
      current ? preferSessionRow(current, candidate, liveSessionTargets) : candidate,
    );
  }
  const rows = applySessionOrder(
    [...deduplicatedByPane.values()],
    reconciledSessionOrder,
    (row) => row.sortId,
  );

  if (rows.length === 0) {
    return null;
  }

  const dragNameFor = (sortId: string | number): string => {
    const row = rows.find((candidate) => candidate.sortId === String(sortId));
    if (!row) return t('liveSessions.unknownSession');
    if (row.kind === 'external') return row.session.tmuxName;
    if (row.kind === 'matched') {
      return liveSessionNames.get(row.id)
        ?? row.session.summary
        ?? row.session.name
        ?? t('liveSessions.unknownSession');
    }
    return liveSessionNames.get(row.id) ?? t('liveSessions.unknownSession');
  };

  const statusOf = (id: string): CloseStatus => closeStatus.get(id) ?? { kind: 'idle' };
  const setStatusOf = (id: string, status: CloseStatus) => {
    setCloseStatus((prev) => {
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
        throw new Error(body?.error?.message ?? t('liveSessions.openPreviousFailed'));
      }
      const projectId = typeof session.projectId === 'string' ? session.projectId : '';
      const project = projects.find((candidate) => candidate.projectId === projectId);
      if (!project) {
        throw new Error(t('liveSessions.projectMissing'));
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
        error instanceof Error ? error.message : t('liveSessions.openPreviousFailed'),
      ));
    } finally {
      setOpeningId(null);
    }
  };

  const closeTmuxSession = async (sessionId: string) => {
    const target = liveSessionTargets.get(sessionId);
    if (!target) {
      setStatusOf(sessionId, { kind: 'error', text: t('liveSessions.targetReplaced') });
      return;
    }
    setStatusOf(sessionId, { kind: 'stopping' });
    try {
      const response = await api.liveSessionKill(target.tmux, target.process, 'session');
      const body = await response.json().catch(() => null);
      const data = (body?.data ?? body ?? {}) as { ok?: boolean; detail?: string };
      if (response.ok && data.ok) {
        setStatusOf(sessionId, { kind: 'idle' });
        setClosedIds((prev) => new Set([...prev, sessionId]));
        return;
      }
      const text = response.status === 409
        ? t('liveSessions.targetReplacedRetry')
        : response.status === 403
          ? t('liveSessions.protectedTarget')
          : (typeof body?.error === 'string' && body.error) || data.detail || t('liveSessions.stopFailed');
      setStatusOf(sessionId, { kind: 'error', text });
    } catch {
      setStatusOf(sessionId, { kind: 'error', text: t('liveSessions.stopFailed') });
    }
  };

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;

    const nextVisibleOrder = moveSession(
      rows.map((row) => row.sortId),
      String(active.id),
      String(over.id),
    );
    const nextOrder = mergeVisibleSessionOrder(reconciledSessionOrder, nextVisibleOrder);
    setSessionOrder(nextOrder);
    persistSessionOrder(nextOrder);
  };

  // Matched and orphan rows share the same whole-session close flow.
  const closeButton = (id: string, tmuxName: string) =>
    statusOf(id).kind === 'idle' ? (
      <button
        type="button"
        title={t('liveSessions.closeSessionTitle', { name: tmuxName })}
        aria-label={t('liveSessions.closeSessionTitle', { name: tmuxName })}
        onClick={() => setStatusOf(id, { kind: 'confirming' })}
        className="mr-1 mt-1.5 rounded p-1 text-muted-foreground/60 transition-colors hover:bg-red-500/10 hover:text-red-500"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    ) : null;

  const closeStrip = (id: string, tmuxName: string) => {
    const status = statusOf(id);
    if (status.kind === 'idle') return null;
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
              {t('liveSessions.close')}
            </button>
          </p>
        ) : (
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-[11px] text-muted-foreground">
              {status.kind === 'stopping'
                ? t('liveSessions.stopping')
                : t('liveSessions.closeSessionConfirm', { name: tmuxName })}
            </span>
            {status.kind === 'confirming' && (
              <span className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  onClick={() => void closeTmuxSession(id)}
                  className="rounded bg-red-600 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-red-700"
                >
                  {t('liveSessions.closeSession')}
                </button>
                <button type="button" onClick={() => setStatusOf(id, { kind: 'idle' })} className="px-1 text-[11px] text-muted-foreground">
                  {t('liveSessions.cancel')}
                </button>
              </span>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <DndContext
      accessibility={{
        screenReaderInstructions: {
          draggable: t('liveSessions.dragInstructions'),
        },
        announcements: {
          onDragStart: ({ active }) => t('liveSessions.dragPickedUp', {
            name: dragNameFor(active.id),
          }),
          onDragOver: ({ active, over }) => (
            over && active.id !== over.id
              ? t('liveSessions.dragMoved', {
                name: dragNameFor(active.id),
                over: dragNameFor(over.id),
              })
              : undefined
          ),
          onDragEnd: ({ active, over }) => (
            over
              ? t('liveSessions.dragDropped', {
                name: dragNameFor(active.id),
                over: dragNameFor(over.id),
              })
              : t('liveSessions.dragCancelled', { name: dragNameFor(active.id) })
          ),
          onDragCancel: ({ active }) => t('liveSessions.dragCancelled', {
            name: dragNameFor(active.id),
          }),
        },
      }}
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={handleDragEnd}
    >
      <div className="px-2 py-2">
        <SortableContext
          items={rows.map((row) => row.sortId)}
          strategy={verticalListSortingStrategy}
        >
          <div className="space-y-0.5">
            {rows.map((row) => {
              if (row.kind === 'external') {
                return (
                  <SidebarExternalSessionRow
                    key={row.id}
                    session={row.session}
                    projects={projects}
                    onOpen={onExternalTerminalOpen ?? NOOP_EXTERNAL_OPEN}
                    onChanged={onExternalSessionsChanged ?? NOOP_EXTERNAL_CHANGED}
                    pendingTranscriptRef={pendingExternalTranscriptRef}
                    sortId={row.sortId}
                    sortableDisabled={rows.length < 2}
                  />
                );
              }
              if (row.kind === 'matched') {
                const { project, session, sortId } = row;
                const isSelected = selectedSession?.id === session.id;
                const title = session.summary || session.name || 'Session';
                const tmuxName = liveSessionNames.get(session.id);
                const primary = tmuxName ?? title;
                const age = formatAge(getSessionTime(session));
                const model = liveSessionModels.get(session.id)?.split('/').pop();
                const effort = liveSessionEfforts.get(session.id);
                const metadata = [
                  model,
                  effort ? `${effort} effort` : null,
                  project.displayName,
                  age || null,
                ].filter(Boolean).join(' · ');
                const isGjcAppSession = (session.__provider ?? session.provider) === 'gjc'
                  && isStableGjcSessionId(session.id);
                const isPresent = row.presence === 'present';
                const canClose = Boolean(
                  isPresent
                  && tmuxName
                  && liveSessionLineage.has(session.id)
                  && liveSessionTargets.has(session.id),
                );

                return (
                  <SortableSessionRow
                    key={session.id}
                    id={sortId}
                    dragLabel={t('liveSessions.reorderSession', { name: primary })}
                    disabled={rows.length < 2}
                    selected={isSelected}
                    content={(
                      <button
                        type="button"
                        title={title}
                        disabled={!isPresent || liveSessionConnectionIssues.has(session.id)}
                        aria-disabled={!isPresent || liveSessionConnectionIssues.has(session.id)}
                        onClick={() => onSessionSelect(session, project.projectId)}
                        className="flex min-w-0 flex-1 items-start gap-2 px-1.5 py-1.5 text-left disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        <SessionProviderLogo provider="gjc" className="mt-0.5 h-4 w-4 flex-shrink-0" />
                        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                          <span className="flex items-center gap-2">
                            {isPresent && (
                              <SessionActivityBadge
                                state={liveSessionConnectionIssues.has(session.id)
                                  || liveSessionErrors.has(session.id)
                                  ? 'error'
                                  : liveSessionInput.has(session.id) ? 'input'
                                  : liveSessionRunning.has(session.id) ? 'running' : 'ready'}
                              />
                            )}
                            {isPresent && liveSessionKinds.get(session.id) === 'batch' && (
                              <span
                                className="shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-600 dark:text-amber-400"
                                aria-label={t('liveSessions.batchTitle')}
                              >
                                BATCH
                              </span>
                            )}
                            <span className="truncate text-sm font-medium text-foreground">{primary}</span>
                          </span>
                          <span className="truncate text-[11px] text-muted-foreground">
                            {metadata}
                          </span>
                        </span>
                      </button>
                    )}
                    actions={(
                      <>
                        {isPresent && isGjcAppSession && (
                          <SessionCompletionBell
                            descriptor={{ kind: 'app', provider: 'gjc', sessionId: session.id }}
                            className="mt-1.5"
                          />
                        )}
                        {canClose && closeButton(session.id, tmuxName!)}
                      </>
                    )}
                    details={(
                      <>
                        {liveSessionConnectionIssues.has(session.id) && (
                          <p className="flex items-start gap-1.5 px-2 pb-1.5 pl-10 text-[11px] text-amber-600 dark:text-amber-400" role="alert">
                            <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
                            <span>{t(`connectionIssues.${liveSessionConnectionIssues.get(session.id)}`, { agent: 'GJC' })}</span>
                          </p>
                        )}
                        {canClose && closeStrip(session.id, tmuxName!)}
                      </>
                    )}
                  />
                );
              }

              const { id, sortId } = row;
              const tmuxName = liveSessionNames.get(id);
              // Server-synthetic row: a GJC TUI runs in this tmux session but has
              // no transcript yet. It is ready for its first message.
              const isIdle = id.startsWith('idle-gjc:');
              const model = liveSessionModels.get(id)?.split('/').pop();
              const effort = liveSessionEfforts.get(id);
              const metadata = [
                model,
                effort ? `${effort} effort` : null,
              ].filter(Boolean).join(' · ');
              const isPresent = row.presence === 'present';
              const canClose = Boolean(
                isPresent
                && tmuxName
                && liveSessionLineage.has(id)
                && liveSessionTargets.has(id),
              );
              const content = (
                <>
                  <SessionProviderLogo provider="gjc" className="mt-0.5 h-4 w-4 flex-shrink-0" />
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="flex items-center gap-2">
                      {isPresent && (
                        <SessionActivityBadge state={liveSessionConnectionIssues.has(id)
                          || liveSessionErrors.has(id)
                          ? 'error'
                          : liveSessionInput.has(id) ? 'input'
                          : liveSessionRunning.has(id) ? 'running' : 'ready'} />
                      )}
                      {isPresent && liveSessionKinds.get(id) === 'batch' && (
                        <span
                          className="shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-600 dark:text-amber-400"
                          aria-label={t('liveSessions.batchTitle')}
                        >
                          BATCH
                        </span>
                      )}
                      <span className="truncate text-sm font-medium text-foreground">
                        {tmuxName}
                      </span>
                    </span>
                    <span className="truncate text-[11px] text-muted-foreground">
                      {metadata || (isIdle
                        ? t('liveSessions.idleHint')
                        : openingId === id
                          ? t('liveSessions.openingPrevious')
                          : t('liveSessions.openPreviousHint'))}
                    </span>
                  </span>
                </>
              );

              return (
                <SortableSessionRow
                  key={id}
                  id={sortId}
                  dragLabel={t('liveSessions.reorderSession', { name: tmuxName ?? id })}
                  disabled={rows.length < 2}
                  content={isIdle ? (
                    <button
                      type="button"
                      disabled={!isPresent || liveSessionConnectionIssues.has(id)}
                      aria-disabled={!isPresent || liveSessionConnectionIssues.has(id)}
                      onClick={() => {
                        const target = liveSessionTargets.get(id);
                        if (tmuxName && target && projects[0]) {
                          onExternalTerminalOpen?.({
                            tmuxName,
                            ...target,
                            kind: 'GJC',
                            cliKind: 'gjc',
                            project: projects[0],
                          });
                        }
                      }}
                      className="flex min-w-0 flex-1 items-start gap-2 px-1.5 py-1.5 text-left disabled:cursor-not-allowed disabled:opacity-60"
                      title={tmuxName ? t('liveSessions.startFirstConversation', { name: tmuxName }) : undefined}
                    >
                      {content}
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={!isPresent || openingId !== null}
                      onClick={() => void openOrphan(id)}
                      className="flex min-w-0 flex-1 items-start gap-2 px-1.5 py-1.5 text-left disabled:opacity-60"
                    >
                      {content}
                    </button>
                  )}
                  actions={(
                    <>
                      {isPresent && !isIdle && isStableGjcSessionId(id) && (
                        <SessionCompletionBell
                          descriptor={{ kind: 'app', provider: 'gjc', sessionId: id }}
                          className="mt-1.5"
                        />
                      )}
                      {canClose && closeButton(id, tmuxName!)}
                    </>
                  )}
                  details={(
                    <>
                      {isPresent && openError.has(id) && (
                        <p className="px-2 pb-1.5 pl-10 text-[11px] text-red-500">{openError.get(id)}</p>
                      )}
                      {isPresent && liveSessionConnectionIssues.has(id) && (
                        <p className="flex items-start gap-1.5 px-2 pb-1.5 pl-10 text-[11px] text-amber-600 dark:text-amber-400" role="alert">
                          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
                          <span>{t(`connectionIssues.${liveSessionConnectionIssues.get(id)}`, { agent: 'GJC' })}</span>
                        </p>
                      )}
                      {canClose && closeStrip(id, tmuxName!)}
                    </>
                  )}
                />
              );
            })}
          </div>
        </SortableContext>
      </div>
    </DndContext>
  );
}
