/**
 * Session and live-pane rows for one remote host.
 *
 * Remote rows intentionally use the same sortable row shell as local live
 * sessions. Their order is persisted in the shared, host-qualified order list,
 * so equal session or tmux ids on two machines never collide.
 */

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
import { Server, SquareTerminal } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { HostGroup, HostGroupRow } from '../../../../../fleet/discovery/hostGroups';
import {
  applySessionOrder,
  createSessionOrderId,
  mergeVisibleSessionOrder,
  moveSession,
  persistSessionOrder,
  readStoredSessionOrder,
} from '../../../utils/sessionOrder';
import SessionProviderLogo from '../../../../llm-logo-provider/SessionProviderLogo';
import SessionActivityBadge, { type SessionActivityState } from '../SessionActivityBadge';
import SortableSessionRow from '../SortableSessionRow';

import { hostDisplayLabel } from './hostLabels';
import { effectiveHostState } from './HostStatusBadge';

type SidebarRemoteHostRowsProps = {
  group: HostGroup;
  selectedLocalId?: string | null;
  onSelect: (row: HostGroupRow) => void;
};

const AGENT_PROVIDERS = new Set(['claude', 'codex', 'cursor', 'opencode', 'gjc', 'omp', 'omo']);

function rowOrderId(hostId: string, row: HostGroupRow): string {
  return createSessionOrderId(row.localId, row.pane?.tmux, hostId);
}

function rowActivity(row: HostGroupRow, enabled: boolean): SessionActivityState | null {
  if (!enabled || row.pane === null || !AGENT_PROVIDERS.has(row.provider.toLowerCase())) return null;
  switch (row.pane.activity) {
    case 'running': return 'running';
    case 'waiting_user': return 'ready';
    case 'asking_user': return 'input';
    case 'error': return 'error';
    default: return 'ready';
  }
}

function ProviderIcon({ provider }: { provider: string }) {
  const normalized = provider.toLowerCase();
  if (normalized === 'ssh') {
    return <Server className="mt-0.5 h-4 w-4 flex-shrink-0 text-slate-400" aria-hidden />;
  }
  if (normalized === 'shell' || !AGENT_PROVIDERS.has(normalized)) {
    return <SquareTerminal className="mt-0.5 h-4 w-4 flex-shrink-0 text-slate-400" aria-hidden />;
  }
  return <SessionProviderLogo provider={normalized} className="mt-0.5 h-4 w-4 flex-shrink-0" />;
}

export default function SidebarRemoteHostRows({
  group,
  selectedLocalId = null,
  onSelect,
}: SidebarRemoteHostRowsProps) {
  const { t } = useTranslation('sidebar');
  const [sessionOrder, setSessionOrder] = useState<string[]>(readStoredSessionOrder);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const host = hostDisplayLabel(group, t);
  const status = t(`hostGroups.status.${effectiveHostState(group.state, group.sync)}`);
  const rows = useMemo(() => applySessionOrder(
    group.rows,
    sessionOrder,
    (row) => rowOrderId(group.hostId, row),
  ), [group.hostId, group.rows, sessionOrder]);
  const ids = rows.map((row) => rowOrderId(group.hostId, row));

  const dragNameFor = (id: string | number): string => (
    rows.find((row) => rowOrderId(group.hostId, row) === String(id))?.label
    ?? t('liveSessions.unknownSession')
  );

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (!group.actionsEnabled || !over || active.id === over.id) return;
    const activeRow = rows.find((row) => rowOrderId(group.hostId, row) === String(active.id));
    const overRow = rows.find((row) => rowOrderId(group.hostId, row) === String(over.id));
    if (!activeRow || !overRow || activeRow.stale || overRow.stale) return;

    const nextVisibleOrder = moveSession(ids, String(active.id), String(over.id));
    // Read once more at the write boundary so a reorder made in another host
    // group since this component mounted is retained.
    const persistedOrder = readStoredSessionOrder();
    const baseOrder = persistedOrder.length > 0 ? persistedOrder : sessionOrder;
    const nextOrder = mergeVisibleSessionOrder(baseOrder, nextVisibleOrder);
    setSessionOrder(nextOrder);
    persistSessionOrder(nextOrder);
  };

  return (
    <DndContext
      accessibility={{
        screenReaderInstructions: { draggable: t('liveSessions.dragInstructions') },
        announcements: {
          onDragStart: ({ active }) => t('liveSessions.dragPickedUp', { name: dragNameFor(active.id) }),
          onDragOver: ({ active, over }) => (
            over && active.id !== over.id
              ? t('liveSessions.dragMoved', { name: dragNameFor(active.id), over: dragNameFor(over.id) })
              : undefined
          ),
          onDragEnd: ({ active, over }) => (
            over
              ? t('liveSessions.dragDropped', { name: dragNameFor(active.id), over: dragNameFor(over.id) })
              : t('liveSessions.dragCancelled', { name: dragNameFor(active.id) })
          ),
          onDragCancel: ({ active }) => t('liveSessions.dragCancelled', { name: dragNameFor(active.id) }),
        },
      }}
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={handleDragEnd}
    >
      <div className="px-2 py-2">
        <SortableContext items={ids} strategy={verticalListSortingStrategy}>
          <div className="space-y-0.5">
            {rows.map((row) => {
              const enabled = group.actionsEnabled && !row.stale;
              const activity = rowActivity(row, enabled);
              const provider = row.provider.toLowerCase();
              const attachOnly = provider === 'ssh' || provider === 'shell';
              return (
                <SortableSessionRow
                  key={row.key}
                  id={rowOrderId(group.hostId, row)}
                  dragLabel={t('liveSessions.reorderSession', { name: row.label })}
                  disabled={!enabled || rows.length < 2}
                  selected={selectedLocalId !== null && row.transcriptLocalId === selectedLocalId}
                  content={(
                    <button
                      type="button"
                      data-host-row="true"
                      data-host-row-kind={row.kind}
                      disabled={!enabled}
                      aria-disabled={!enabled}
                      aria-label={enabled
                        ? t('hostGroups.openRow', { name: row.label, host })
                        : t('hostGroups.disabledRow', { name: row.label, host, status })}
                      onClick={() => {
                        // The guard keeps unavailable remote state fail-closed
                        // even if a caller invokes the handler directly.
                        if (enabled) onSelect(row);
                      }}
                      className="flex min-w-0 flex-1 items-start gap-2 px-1.5 py-1.5 text-left disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      <ProviderIcon provider={row.provider} />
                      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="flex min-w-0 items-center gap-1.5">
                          {activity && <SessionActivityBadge state={activity} />}
                          <span className="truncate text-sm font-medium text-foreground">{row.label}</span>
                          {row.duplicateLabel && (
                            <span className="shrink-0 rounded bg-secondary px-1.5 py-0.5 text-[10px] font-semibold text-secondary-foreground">
                              {t('hostGroups.hostChip', { host })}
                            </span>
                          )}
                        </span>
                        <span className="truncate text-[11px] text-muted-foreground">
                          {row.stale ? `${row.detail} · ${t('hostGroups.stale')}` : row.detail}
                        </span>
                      </span>
                      {attachOnly && (
                        <SquareTerminal className="mt-1 h-3.5 w-3.5 shrink-0 text-muted-foreground/60" aria-hidden />
                      )}
                    </button>
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
