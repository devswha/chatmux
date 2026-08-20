import { useEffect, useRef, useState } from 'react';

import type { ServerEvent } from '../contexts/WebSocketContext';
import type { DiscoveryLane, DiscoveryV2, PublicTerminalTarget, RuntimeCapabilities, SourceLaneState, TmuxDiscoveryProjection } from '../../shared/terminal-runtime';
import { publicTerminalKey, sourceLaneKey } from '../../shared/terminal-runtime';
import type { ProviderConnectionIssue } from '../../shared/provider-connection';

export type { DiscoveryLane } from '../../shared/terminal-runtime';

export type DiscoveryRow = TmuxDiscoveryProjection & {
  connectionIssue?: ProviderConnectionIssue;
  [key: string]: unknown;
};

/** A runtime-neutral operation row used by Herdr-aware surfaces. */
export type RuntimeDiscoveryRow = {
  key: string;
  lane: DiscoveryLane;
  runtime: PublicTerminalTarget['runtime'];
  sourceId: string;
  terminal: PublicTerminalTarget;
  capabilities: RuntimeCapabilities;
  presence: 'present' | 'stale';
  targetId?: string;
};

type StreamArgs = {
  lanes: readonly DiscoveryLane[];
  isConnected: boolean;
  sendMessage: (message: unknown) => void;
  subscribe: (listener: (event: ServerEvent) => void) => () => void;
  onRows: (rows: DiscoveryRow[]) => void;
  onRuntimeRows?: (rows: RuntimeDiscoveryRow[]) => void;
  onHealthChange?: (healthy: boolean) => void;
  onAuthorityChange?: (lane: DiscoveryLane, disposition: DiscoveryAuthorityDisposition) => void;
};

export type DiscoveryAuthorityDisposition = 'stream' | 'rest' | 'none';
type DiscoveryFrameState = { epoch: string | null; revision: number };
type DiscoveryV2Event = { kind: 'discovery.v2.snapshot'; version: 2; discovery: DiscoveryV2 };

const HEARTBEAT_STALE_MS = 15_000;
export const DISCOVERY_TRANSPORT_LANES: readonly DiscoveryLane[] = ['external', 'live'];

export function discoveryAuthorityDisposition(streamAuthoritative: boolean, restAvailable: boolean): DiscoveryAuthorityDisposition {
  return streamAuthoritative ? 'stream' : restAvailable ? 'rest' : 'none';
}

function isV2Snapshot(event: ServerEvent): event is ServerEvent & DiscoveryV2Event {
  const value = event as unknown as Partial<DiscoveryV2Event>;
  return value.kind === 'discovery.v2.snapshot' && value.version === 2 && Boolean(value.discovery)
    && value.discovery!.version === 2;
}

function sourceStates(discovery: DiscoveryV2, lane: DiscoveryLane): SourceLaneState[] {
  return discovery.sourceLanes.filter((source) => source.lane === lane);
}

/** Discovery is authoritative only when its expected pairs are exactly authoritative and monotonic. */
export function discoveryV2LaneAuthority(discovery: DiscoveryV2, lane: DiscoveryLane): DiscoveryAuthorityDisposition {
  const coverage = discovery.coverageByLane?.[lane];
  const states = sourceStates(discovery, lane);
  if (!coverage || coverage.state !== 'complete' || !Number.isSafeInteger(discovery.globalRevision) || discovery.globalRevision < 0) return 'rest';
  const expected = new Set(coverage.expectedSourceLaneKeys);
  const authoritative = new Set(coverage.authoritativeSourceLaneKeys);
  if (expected.size !== states.length || expected.size !== authoritative.size) return 'rest';
  for (const state of states) {
    const key = sourceLaneKey(lane, state.sourceId);
    if (!expected.has(key) || !authoritative.has(key) || state.coverage !== 'authoritative'
      || !Number.isSafeInteger(state.sourceLaneRevision) || state.sourceLaneRevision < 0) return 'rest';
  }
  return 'stream';
}

/** Projects exact DiscoveryV2 lane/terminal entries without inferring a tmux lane. */
export function projectDiscoveryV2Rows(discovery: DiscoveryV2, lane: DiscoveryLane): RuntimeDiscoveryRow[] {
  const authoritative = new Set(discovery.coverageByLane?.[lane]?.authoritativeSourceLaneKeys ?? []);
  const sources = discovery.sourceLanes.filter((state) => (
    state.lane === lane
    && state.coverage === 'authoritative'
    && authoritative.has(sourceLaneKey(lane, state.sourceId))
  ));
  const capabilities = new Map(sources.map((state) => [state.sourceId, state.capabilities]));
  return discovery.terminals
    .filter((entry) => entry.lane === lane)
    .filter(({ terminal }) => sources.some((source) => source.sourceId === (
      terminal.runtime === 'herdr' ? terminal.sourceId : 'tmux.local'
    )))
    .map(({ terminal }) => {
      const sourceId = terminal.runtime === 'herdr' ? terminal.sourceId : 'tmux.local';
      return {
        key: publicTerminalKey(lane, terminal), lane, runtime: terminal.runtime, sourceId,
        terminal, capabilities: capabilities.get(sourceId) ?? { discovery: false, output: false, actions: false, attach: false, create: false },
        presence: 'present' as const,
        ...(terminal.runtime === 'herdr' ? { targetId: terminal.targetId } : {}),
      };
    });
}

/** Reject epoch changes, gaps, duplicate/regressed global revisions, and pair regressions. */
export function discoveryV2ResyncReason(
  discovery: DiscoveryV2,
  state: DiscoveryFrameState,
  pairRevisions: ReadonlyMap<string, number>,
  previousPayload: string | null,
): 'epoch_mismatch' | 'gap' | 'pair_regression' | 'same_revision_disagreement' | null {
  if (!discovery.epoch || !Number.isSafeInteger(discovery.globalRevision) || discovery.globalRevision < 0) return 'gap';
  if (state.epoch !== null && discovery.epoch !== state.epoch) return 'epoch_mismatch';
  if (state.epoch !== null && (discovery.globalRevision < state.revision || discovery.globalRevision > state.revision + 1)) return 'gap';
  const payload = JSON.stringify(discovery);
  if (state.epoch !== null && discovery.globalRevision === state.revision && previousPayload !== payload) return 'same_revision_disagreement';
  for (const source of discovery.sourceLanes) {
    const previous = pairRevisions.get(sourceLaneKey(source.lane, source.sourceId));
    if (previous !== undefined && source.sourceLaneRevision < previous) return 'pair_regression';
  }
  return null;
}

export function useDiscoveryStream({ lanes, isConnected, sendMessage, subscribe, onRows, onRuntimeRows, onHealthChange, onAuthorityChange }: StreamArgs): boolean {
  const stateRef = useRef<DiscoveryFrameState>({ epoch: null, revision: 0 });
  const pairsRef = useRef(new Map<string, number>());
  const payloadRef = useRef<string | null>(null);
  const onRowsRef = useRef(onRows);
  const onRuntimeRowsRef = useRef(onRuntimeRows);
  const onHealthChangeRef = useRef(onHealthChange);
  const onAuthorityChangeRef = useRef(onAuthorityChange);
  const [streamHealthy, setStreamHealthy] = useState(false);
  onRowsRef.current = onRows;
  onRuntimeRowsRef.current = onRuntimeRows;
  onHealthChangeRef.current = onHealthChange;
  onAuthorityChangeRef.current = onAuthorityChange;
  const lanesKey = lanes.join(',');

  useEffect(() => {
    const subscribedLanes = lanesKey ? lanesKey.split(',') as DiscoveryLane[] : [];
    let lastFrameAt = 0;
    const authority: Record<DiscoveryLane, DiscoveryAuthorityDisposition> = { external: 'none', live: 'none' };
    const setAuthority = (lane: DiscoveryLane, next: DiscoveryAuthorityDisposition) => {
      if (authority[lane] === next) return;
      authority[lane] = next;
      onAuthorityChangeRef.current?.(lane, next);
      const healthy = subscribedLanes.some((candidate) => authority[candidate] === 'stream');
      setStreamHealthy(healthy);
      onHealthChangeRef.current?.(healthy);
    };
    const reset = (reason: string) => {
      stateRef.current = { epoch: null, revision: 0 };
      pairsRef.current = new Map();
      payloadRef.current = null;
      for (const lane of subscribedLanes) setAuthority(lane, 'rest');
      sendMessage({ type: 'discovery.resync', reason });
    };
    const subscribeV2 = () => sendMessage({ type: 'discovery.subscribe', protocolVersion: 2, lanes: subscribedLanes,
      known: stateRef.current.epoch === null ? null : { epoch: stateRef.current.epoch, globalRevision: stateRef.current.revision } });
    const apply = (event: ServerEvent) => {
      if (event.kind === 'websocket_reconnected') { subscribeV2(); return; }
      if (event.kind === 'discovery.resync_required') { reset('gap'); return; }
      const heartbeat = event as unknown as { kind?: string; version?: number; epoch?: string; globalRevision?: number };
      if (heartbeat.kind === 'discovery.v2.heartbeat') {
        if (heartbeat.version === 2 && heartbeat.epoch === stateRef.current.epoch && heartbeat.globalRevision === stateRef.current.revision
          && subscribedLanes.some((lane) => authority[lane] === 'stream')) lastFrameAt = Date.now();
        return;
      }
      if (!isV2Snapshot(event)) return;
      const discovery = event.discovery;
      const reason = discoveryV2ResyncReason(discovery, stateRef.current, pairsRef.current, payloadRef.current);
      if (reason) { reset(reason); return; }
      stateRef.current = { epoch: discovery.epoch, revision: discovery.globalRevision };
      payloadRef.current = JSON.stringify(discovery);
      pairsRef.current = new Map(discovery.sourceLanes.map((source) => [sourceLaneKey(source.lane, source.sourceId), source.sourceLaneRevision]));
      lastFrameAt = Date.now();
      const runtimeRows = subscribedLanes.flatMap((lane) => projectDiscoveryV2Rows(discovery, lane));
      for (const lane of subscribedLanes) setAuthority(lane, isConnected ? discoveryV2LaneAuthority(discovery, lane) : 'rest');
      if (subscribedLanes.some((lane) => authority[lane] === 'stream')) {
        onRowsRef.current((discovery.tmuxRows ?? []).filter((row) => subscribedLanes.includes(row.lane)));
      }
      onRuntimeRowsRef.current?.(runtimeRows);
    };
    const unsubscribe = subscribe(apply);
    if (isConnected) subscribeV2(); else for (const lane of subscribedLanes) setAuthority(lane, 'rest');
    const timer = window.setInterval(() => {
      if (!lastFrameAt || Date.now() - lastFrameAt > HEARTBEAT_STALE_MS) for (const lane of subscribedLanes) setAuthority(lane, 'rest');
    }, HEARTBEAT_STALE_MS);
    return () => { window.clearInterval(timer); unsubscribe(); for (const lane of subscribedLanes) setAuthority(lane, 'none'); };
  }, [isConnected, lanesKey, sendMessage, subscribe]);
  return streamHealthy;
}
