import { useEffect, useRef, useState } from 'react';

import type { ServerEvent } from '../contexts/WebSocketContext';
import type { TmuxPaneIdentity, TmuxProcessGeneration } from '../../shared/tmux';

export type DiscoveryLane = 'external' | 'live';
export type DiscoveryRow = {
  key: string;
  lane: DiscoveryLane;
  tmuxName: string;
  tmux: TmuxPaneIdentity;
  process: TmuxProcessGeneration | null;
  kind: string;
  providerSessionId: string | null;
  activity: 'running' | 'waiting_user' | 'asking_user' | 'unknown';
  cwd: string | null;
  presence: 'present' | 'stale';
  [key: string]: unknown;
};

type StreamArgs = {
  lanes: readonly DiscoveryLane[];
  isConnected: boolean;
  sendMessage: (message: unknown) => void;
  subscribe: (listener: (event: ServerEvent) => void) => () => void;
  onRows: (rows: DiscoveryRow[]) => void;
};

const HEARTBEAT_STALE_MS = 15_000;
export function discoveryDeltaResyncReason(
  event: ServerEvent,
  state: Pick<{ epoch: string | null; revision: number }, 'epoch' | 'revision'>,
): 'epoch_mismatch' | 'gap' | null {
  if (event.kind !== 'discovery.delta' || !Array.isArray(event.changes)) return null;
  if (event.epoch !== state.epoch) return 'epoch_mismatch';
  return event.prevRevision !== state.revision ? 'gap' : null;
}


/** Applies the ordered display-only discovery stream. REST callers remain the fallback. */
export function useDiscoveryStream({ lanes, isConnected, sendMessage, subscribe, onRows }: StreamArgs): boolean {
  const stateRef = useRef<{ epoch: string | null; revision: number; rows: Map<string, DiscoveryRow> }>({ epoch: null, revision: 0, rows: new Map() });
  const onRowsRef = useRef(onRows);
  const [streamHealthy, setStreamHealthy] = useState(false);
  onRowsRef.current = onRows;
  const lanesKey = lanes.join(',');

  useEffect(() => {
    const subscribedLanes = lanesKey.split(',') as DiscoveryLane[];
    let lastFrameAt = 0;
    const emit = () => onRowsRef.current([...stateRef.current.rows.values()].filter((row) => subscribedLanes.includes(row.lane)));
    const markAlive = () => {
      lastFrameAt = Date.now();
      setStreamHealthy(true);
    };
    const resetAndResync = (reason: 'epoch_mismatch' | 'gap') => {
      stateRef.current = { epoch: null, revision: 0, rows: new Map() };
      emit();
      setStreamHealthy(false);
      sendMessage({ type: 'discovery.resync', reason });
    };
    const apply = (event: ServerEvent) => {
      if (event.kind === 'websocket_reconnected') {
        const { epoch, revision } = stateRef.current;
        sendMessage({
          type: 'discovery.subscribe',
          protocolVersion: 1,
          lanes: subscribedLanes,
          known: epoch === null ? null : { epoch, revision },
        });
        return;
      }
      if (event.kind === 'discovery.resync_required') {
        resetAndResync('gap');
        return;
      }
      if (event.kind === 'discovery.snapshot') {
        const epoch = typeof event.epoch === 'string' ? event.epoch : null;
        const revision = typeof event.revision === 'number' ? event.revision : null;
        if (epoch === null || revision === null || !Array.isArray(event.rows)) return;
        const rows = event.rows.filter((row): row is DiscoveryRow => Boolean(row && typeof row === 'object' && typeof (row as DiscoveryRow).key === 'string'));
        stateRef.current = { epoch, revision, rows: new Map(rows.map((row) => [row.key, row])) };
        emit();
        markAlive();
        return;
      }
      if (event.kind === 'discovery.heartbeat') {
        if (event.epoch === stateRef.current.epoch && event.revision === stateRef.current.revision) markAlive();
        return;
      }
      const resyncReason = discoveryDeltaResyncReason(event, stateRef.current);
      if (resyncReason) {
        resetAndResync(resyncReason);
        return;
      }
      if (event.kind !== 'discovery.delta' || !Array.isArray(event.changes)) return;
      for (const change of event.changes as Array<Record<string, unknown>>) {
        if (change.op === 'added' && change.row && typeof change.row === 'object') {
          const row = change.row as DiscoveryRow;
          stateRef.current.rows.set(row.key, row);
        } else if (change.op === 'updated' && typeof change.key === 'string' && change.patch && typeof change.patch === 'object') {
          const row = stateRef.current.rows.get(change.key);
          if (row) stateRef.current.rows.set(change.key, { ...row, ...(change.patch as Partial<DiscoveryRow>) });
        } else if (change.op === 'stale' && typeof change.key === 'string') {
          const row = stateRef.current.rows.get(change.key);
          if (row) stateRef.current.rows.set(change.key, { ...row, presence: 'stale' });
        } else if (change.op === 'removed' && typeof change.key === 'string') stateRef.current.rows.delete(change.key);
      }
      stateRef.current.revision = typeof event.revision === 'number' ? event.revision : stateRef.current.revision;
      emit();
      markAlive();
    };
    const unsubscribe = subscribe(apply);
    if (isConnected) {
      const { epoch, revision } = stateRef.current;
      sendMessage({
        type: 'discovery.subscribe',
        protocolVersion: 1,
        lanes: subscribedLanes,
        known: epoch === null ? null : { epoch, revision },
      });
    } else {
      setStreamHealthy(false);
    }
    const heartbeatTimer = window.setInterval(() => {
      if (lastFrameAt === 0 || Date.now() - lastFrameAt > HEARTBEAT_STALE_MS) setStreamHealthy(false);
    }, HEARTBEAT_STALE_MS);
    return () => {
      window.clearInterval(heartbeatTimer);
      unsubscribe();
    };
  }, [isConnected, lanesKey, sendMessage, subscribe]);

  return streamHealthy;
}
