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
  activity: 'running' | 'waiting_user' | 'asking_user' | 'error' | 'unknown';
  tmuxActionable?: boolean;
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
  onHealthChange?: (healthy: boolean) => void;
  onAuthorityChange?: (lane: DiscoveryLane, disposition: DiscoveryAuthorityDisposition) => void;
};

export type DiscoveryAuthorityDisposition = 'stream' | 'rest' | 'none';

type DiscoveryFrameState = Pick<{ epoch: string | null; revision: number }, 'epoch' | 'revision'>;

const HEARTBEAT_STALE_MS = 15_000;
// The shared WebSocket has one server-side discovery subscription. Each hook
// filters this union locally so a later lane consumer cannot replace another.
export const DISCOVERY_TRANSPORT_LANES: readonly DiscoveryLane[] = ['external', 'live'];

export function discoveryAuthorityDisposition(
  streamAuthoritative: boolean,
  restAvailable: boolean,
): DiscoveryAuthorityDisposition {
  if (streamAuthoritative) return 'stream';
  return restAvailable ? 'rest' : 'none';
}

export function discoveryFrameAuthorityDisposition(
  event: ServerEvent,
  state: DiscoveryFrameState,
  lane: DiscoveryLane,
  isConnected: boolean,
  isFresh: boolean,
): DiscoveryAuthorityDisposition {
  if (
    !isConnected
    || !isFresh
    || !Number.isInteger(state.revision)
    || (event.kind !== 'discovery.snapshot' && event.kind !== 'discovery.delta')
    || event.epoch !== state.epoch
    || event.revision !== state.revision
  ) {
    return discoveryAuthorityDisposition(false, true);
  }
  const health = event.health;
  if (
    !health
    || typeof health !== 'object'
    || Array.isArray(health)
    || !Object.prototype.hasOwnProperty.call(health, lane)
  ) {
    return discoveryAuthorityDisposition(false, true);
  }
  const laneHealth = (health as Record<string, unknown>)[lane];
  if (!laneHealth || typeof laneHealth !== 'object' || Array.isArray(laneHealth)) {
    return discoveryAuthorityDisposition(false, true);
  }
  const ok = Object.prototype.hasOwnProperty.call(laneHealth, 'ok')
    && (laneHealth as { ok?: unknown }).ok === true;
  const lastOkRevision = Object.prototype.hasOwnProperty.call(laneHealth, 'lastOkRevision')
    ? (laneHealth as { lastOkRevision?: unknown }).lastOkRevision
    : null;
  return discoveryAuthorityDisposition(
    ok
    && typeof lastOkRevision === 'number'
    && Number.isInteger(lastOkRevision)
    && lastOkRevision > 0
    && lastOkRevision <= state.revision,
    true,
  );
}

export function discoveryDeltaResyncReason(
  event: ServerEvent,
  state: DiscoveryFrameState,
): 'epoch_mismatch' | 'gap' | null {
  if (event.kind !== 'discovery.delta' || !Array.isArray(event.changes)) return null;
  if (event.epoch !== state.epoch) return 'epoch_mismatch';
  return event.prevRevision !== state.revision ? 'gap' : null;
}

export type DiscoveryHeartbeatDisposition = 'ignore' | 'keepalive';

export function discoveryHeartbeatDisposition(
  event: ServerEvent,
  state: DiscoveryFrameState,
  streamAuthoritative: boolean,
): DiscoveryHeartbeatDisposition {
  if (
    event.kind !== 'discovery.heartbeat'
    || event.epoch !== state.epoch
    || event.revision !== state.revision
    || !streamAuthoritative
  ) {
    return 'ignore';
  }
  return 'keepalive';
}

/** Applies the ordered display-only discovery stream. REST callers remain the fallback. */
export function useDiscoveryStream({
  lanes,
  isConnected,
  sendMessage,
  subscribe,
  onRows,
  onHealthChange,
  onAuthorityChange,
}: StreamArgs): boolean {
  const stateRef = useRef<{ epoch: string | null; revision: number; rows: Map<string, DiscoveryRow> }>({ epoch: null, revision: 0, rows: new Map() });
  const onRowsRef = useRef(onRows);
  const onHealthChangeRef = useRef(onHealthChange);
  const onAuthorityChangeRef = useRef(onAuthorityChange);
  const authorityRef = useRef<Record<DiscoveryLane, DiscoveryAuthorityDisposition>>({
    external: 'none',
    live: 'none',
  });
  const [streamHealthy, setStreamHealthy] = useState(false);
  onRowsRef.current = onRows;
  onHealthChangeRef.current = onHealthChange;
  onAuthorityChangeRef.current = onAuthorityChange;
  const lanesKey = lanes.join(',');

  useEffect(() => {
    const subscribedLanes = lanesKey.split(',') as DiscoveryLane[];
    let lastFrameAt = 0;
    const emit = () => onRowsRef.current([...stateRef.current.rows.values()].filter((row) => subscribedLanes.includes(row.lane)));
    const hasStreamAuthority = () => subscribedLanes.some((lane) => authorityRef.current[lane] === 'stream');
    const setAuthority = (lane: DiscoveryLane, disposition: DiscoveryAuthorityDisposition) => {
      if (authorityRef.current[lane] === disposition) return;
      const wasHealthy = hasStreamAuthority();
      authorityRef.current[lane] = disposition;
      onAuthorityChangeRef.current?.(lane, disposition);
      const healthy = hasStreamAuthority();
      if (wasHealthy !== healthy) {
        setStreamHealthy(healthy);
        onHealthChangeRef.current?.(healthy);
      }
    };
    const clearAuthority = (disposition: DiscoveryAuthorityDisposition) => {
      for (const lane of subscribedLanes) setAuthority(lane, disposition);
    };
    const markFrameAlive = () => {
      lastFrameAt = Date.now();
    };
    const resetAndResync = (reason: 'epoch_mismatch' | 'gap') => {
      stateRef.current = { epoch: null, revision: 0, rows: new Map() };
      clearAuthority('rest');
      sendMessage({ type: 'discovery.resync', reason });
    };
    const applyFrameAuthority = (event: ServerEvent) => {
      for (const lane of subscribedLanes) {
        setAuthority(
          lane,
          discoveryFrameAuthorityDisposition(event, stateRef.current, lane, isConnected, true),
        );
      }
    };
    const apply = (event: ServerEvent) => {
      if (event.kind === 'websocket_reconnected') {
        const { epoch, revision } = stateRef.current;
        sendMessage({
          type: 'discovery.subscribe',
          protocolVersion: 1,
          lanes: DISCOVERY_TRANSPORT_LANES,
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
        const revision = typeof event.revision === 'number' && Number.isInteger(event.revision)
          ? event.revision
          : null;
        if (epoch === null || revision === null || !Array.isArray(event.rows)) return;
        const rows = event.rows.filter((row): row is DiscoveryRow => Boolean(row && typeof row === 'object' && typeof (row as DiscoveryRow).key === 'string'));
        const retainedRows = stateRef.current.epoch === epoch
          ? new Map(stateRef.current.rows)
          : new Map<string, DiscoveryRow>();
        stateRef.current = { epoch, revision, rows: retainedRows };
        markFrameAlive();
        applyFrameAuthority(event);
        for (const lane of subscribedLanes) {
          for (const [key, row] of retainedRows) {
            if (row.lane === lane) retainedRows.delete(key);
          }
        }
        for (const row of rows) {
          if (subscribedLanes.includes(row.lane)) retainedRows.set(row.key, row);
        }
        if (hasStreamAuthority()) emit();
        return;
      }
      if (event.kind === 'discovery.heartbeat') {
        if (discoveryHeartbeatDisposition(event, stateRef.current, hasStreamAuthority()) === 'keepalive') {
          markFrameAlive();
        }
        return;
      }
      const resyncReason = discoveryDeltaResyncReason(event, stateRef.current);
      if (resyncReason) {
        resetAndResync(resyncReason);
        return;
      }
      if (
        event.kind !== 'discovery.delta'
        || !Array.isArray(event.changes)
        || typeof event.revision !== 'number'
        || !Number.isInteger(event.revision)
      ) return;
      stateRef.current.revision = event.revision;
      markFrameAlive();
      applyFrameAuthority(event);
      for (const change of event.changes as Array<Record<string, unknown>>) {
        if (change.op === 'added' && change.row && typeof change.row === 'object') {
          const row = change.row as DiscoveryRow;
          if (subscribedLanes.includes(row.lane)) stateRef.current.rows.set(row.key, row);
        } else if (change.op === 'updated' && typeof change.key === 'string' && change.patch && typeof change.patch === 'object') {
          const row = stateRef.current.rows.get(change.key);
          if (row) {
            stateRef.current.rows.set(change.key, { ...row, ...(change.patch as Partial<DiscoveryRow>) });
          }
        } else if (change.op === 'stale' && typeof change.key === 'string') {
          const row = stateRef.current.rows.get(change.key);
          if (row) stateRef.current.rows.set(change.key, { ...row, presence: 'stale' });
        } else if (change.op === 'removed' && typeof change.key === 'string') {
          stateRef.current.rows.delete(change.key);
        }
      }
      if (hasStreamAuthority()) emit();
    };
    const unsubscribe = subscribe(apply);
    if (isConnected) {
      const { epoch, revision } = stateRef.current;
      sendMessage({
        type: 'discovery.subscribe',
        protocolVersion: 1,
        lanes: DISCOVERY_TRANSPORT_LANES,
        known: epoch === null ? null : { epoch, revision },
      });
    } else {
      clearAuthority('rest');
    }
    const heartbeatTimer = window.setInterval(() => {
      if (lastFrameAt === 0 || Date.now() - lastFrameAt > HEARTBEAT_STALE_MS) clearAuthority('rest');
    }, HEARTBEAT_STALE_MS);
    return () => {
      window.clearInterval(heartbeatTimer);
      unsubscribe();
      clearAuthority('none');
    };
  }, [isConnected, lanesKey, sendMessage, subscribe]);

  return streamHealthy;
}
