import type { WebSocket } from 'ws';

import type {
  DiscoveryCollector,
  DiscoveryLane,
} from '@/modules/providers/index.js';
import { WS_OPEN_STATE } from '@/modules/websocket/index.js';
import type { AnyRecord } from '@/shared/types.js';

import type { DiscoveryV2 } from '../../../../shared/terminal-runtime.js';

export const MAX_QUEUED_MESSAGES = 64;
export const MAX_QUEUED_BYTES = 1_024 * 1_024;
export const MAX_BUFFERED_AMOUNT = 4 * 1_024 * 1_024;
export const SLOW_CLIENT_MS = 10_000;
export const HEARTBEAT_CADENCE = 5;
export const RESYNC_WINDOW_MS = 10_000;
export const MAX_RESYNCS_PER_WINDOW = 3;

type Subscriber = {
  ws: WebSocket;
  protocolVersion: 2;
  lanes: readonly DiscoveryLane[];
  queue: string[];
  queuedBytes: number;
  slowSince: number | null;
  resyncs: number[];
  awaitingResync: boolean;
};
function send(ws: WebSocket, payload: unknown): boolean {
  if (ws.readyState !== WS_OPEN_STATE) return false;
  ws.send(JSON.stringify(payload));
  return true;
}
function readLanes(value: unknown): DiscoveryLane[] | null {
  if (value === undefined) return ['external', 'live'];
  if (!Array.isArray(value) || value.some((lane) => lane !== 'external' && lane !== 'live')) return null;
  return [...new Set(value)] as DiscoveryLane[];
}

export function projectDiscoveryV2(discovery: DiscoveryV2, lanes: readonly DiscoveryLane[]): DiscoveryV2 {
  const admitted = new Set(lanes);
  const sourceLanes = discovery.sourceLanes.filter((source) => admitted.has(source.lane));
  const sourceIds = new Set(sourceLanes.map((source) => source.sourceId));
  return {
    ...discovery,
    terminals: discovery.terminals.filter((entry) => admitted.has(entry.lane)),
    tmuxRows: discovery.tmuxRows?.filter((row) => admitted.has(row.lane)),
    sourceDescriptors: discovery.sourceDescriptors.filter((source) => sourceIds.has(source.sourceId)),
    sourceLanes,
    coverageByLane: {
      external: admitted.has('external')
        ? discovery.coverageByLane.external
        : { lane: 'external', state: 'unavailable', expectedSourceLaneKeys: [], authoritativeSourceLaneKeys: [], retainedSourceLaneKeys: [], unavailableSourceLaneKeys: [] },
      live: admitted.has('live')
        ? discovery.coverageByLane.live
        : { lane: 'live', state: 'unavailable', expectedSourceLaneKeys: [], authoritativeSourceLaneKeys: [], retainedSourceLaneKeys: [], unavailableSourceLaneKeys: [] },
    },
  };
}

/** Discovery protocol fan-out. It only renders collector state; it is never an authorization input. */
export function createDiscoveryStream(collector: DiscoveryCollector, now = Date.now) {
  const subscribers = new Map<WebSocket, Subscriber>();
  let previousRevision = collector.currentSnapshot().revision;
  let unchangedTicks = 0;
  const unsubscribe = collector.onSnapshot((snapshot) => {
    if (snapshot.revision === previousRevision) {
      unchangedTicks += 1;
      if (unchangedTicks % HEARTBEAT_CADENCE === 0) {
        for (const subscriber of subscribers.values()) {
          if (!subscriber.awaitingResync && subscriber.queue.length === 0 && snapshot.v2) {
            enqueue(subscriber, { kind: 'discovery.v2.heartbeat', version: 2, epoch: snapshot.v2.epoch, globalRevision: snapshot.v2.globalRevision });
          }
        }
      }
      return;
    }
    previousRevision = snapshot.revision;
    unchangedTicks = 0;
    for (const subscriber of subscribers.values()) snapshotV2(subscriber, snapshot);
  });
  function flush(subscriber: Subscriber): void {
    if (subscriber.ws.bufferedAmount > MAX_BUFFERED_AMOUNT) {
      subscriber.slowSince ??= now();
      if (now() - subscriber.slowSince >= SLOW_CLIENT_MS) subscriber.ws.close(1013, 'discovery_slow_client');
      return;
    }
    subscriber.slowSince = null;
    while (subscriber.queue.length && subscriber.ws.readyState === WS_OPEN_STATE) {
      const frame = subscriber.queue.shift()!;
      subscriber.queuedBytes -= Buffer.byteLength(frame);
      subscriber.ws.send(frame);
    }
  }
  function enqueue(subscriber: Subscriber, payload: unknown): void {
    const frame = JSON.stringify(payload);
    if (subscriber.queue.length >= MAX_QUEUED_MESSAGES || subscriber.queuedBytes + Buffer.byteLength(frame) > MAX_QUEUED_BYTES) {
      subscriber.awaitingResync = true;
      subscriber.queue = [JSON.stringify({ kind: 'discovery.resync_required', epoch: collector.currentSnapshot().epoch, reason: 'queue_overflow' })];
      subscriber.queuedBytes = Buffer.byteLength(subscriber.queue[0]!);
    } else {
      subscriber.queue.push(frame);
      subscriber.queuedBytes += Buffer.byteLength(frame);
    }
    flush(subscriber);
  }
  function snapshotV2(
    subscriber: Subscriber,
    current = collector.currentSnapshot(),
    resetAfterResync = false,
  ): void {
    if (subscriber.awaitingResync && !resetAfterResync) {
      flush(subscriber);
      return;
    }
    if (resetAfterResync) {
      subscriber.awaitingResync = false;
      subscriber.queue = [];
      subscriber.queuedBytes = 0;
    }
    if (!current.v2) {
      enqueue(subscriber, { kind: 'protocol_error', code: 'RUNTIME_DISCOVERY_UNAVAILABLE', error: 'Runtime discovery v2 is unavailable.' });
      return;
    }
    enqueue(subscriber, { kind: 'discovery.v2.snapshot', version: 2, discovery: projectDiscoveryV2(current.v2, subscriber.lanes) });
  }
  function subscribe(ws: WebSocket, data: AnyRecord): void {
    if (data.protocolVersion !== 2) {
      send(ws, { kind: 'protocol_error', code: 'CLIENT_RELOAD_REQUIRED', error: 'Runtime discovery requires protocolVersion 2.' });
      return;
    }
    if (!collector.currentSnapshot().v2) {
      send(ws, { kind: 'protocol_error', code: 'RUNTIME_DISCOVERY_UNAVAILABLE', error: 'Runtime discovery v2 is unavailable.' });
      return;
    }
    const requestedLanes = readLanes(data.lanes);
    if (!requestedLanes) { send(ws, { kind: 'protocol_error', code: 'INVALID_DISCOVERY_LANES', error: 'Invalid discovery lanes.' }); return; }
    const existing = subscribers.get(ws);
    const lanes = existing
      ? [...new Set([...existing.lanes, ...requestedLanes])] as DiscoveryLane[]
      : requestedLanes;
    const lanesChanged = !!existing && lanes.length !== existing.lanes.length;
    const subscriber: Subscriber = existing ?? {
      ws,
      protocolVersion: 2,
      lanes,
      queue: [],
      queuedBytes: 0,
      slowSince: null,
      resyncs: [],
      awaitingResync: false,
    };
    subscriber.lanes = lanes;
    subscribers.set(ws, subscriber);
    const known = data.known as AnyRecord | null | undefined;
    const current = collector.currentSnapshot();
    if (!lanesChanged && known && known.epoch === current.v2!.epoch && known.globalRevision === current.v2!.globalRevision) {
      enqueue(subscriber, { kind: 'discovery.v2.heartbeat', version: 2, epoch: current.v2!.epoch, globalRevision: current.v2!.globalRevision });
    } else snapshotV2(subscriber, current, true);
    collector.setActive(true);
    collector.start();
  }
  function handle(ws: WebSocket, data: AnyRecord): boolean {
    if (data.type === 'discovery.subscribe') { subscribe(ws, data); return true; }
    if (data.type === 'discovery.unsubscribe') {
      subscribers.delete(ws);
      if (subscribers.size === 0) collector.setActive(false);
      return true;
    }
    if (data.type === 'discovery.resync') {
      const subscriber = subscribers.get(ws);
      if (subscriber) {
        const cutoff = now() - RESYNC_WINDOW_MS;
        subscriber.resyncs = subscriber.resyncs.filter((at) => at > cutoff);
        if (subscriber.resyncs.length >= MAX_RESYNCS_PER_WINDOW) {
          ws.close(1008, 'discovery_resync_rate_limited');
        } else {
          subscriber.resyncs.push(now());
          snapshotV2(subscriber, collector.currentSnapshot(), true);
        }
      }
      return true;
    }
    return false;
  }
  function close(ws: WebSocket): void {
    subscribers.delete(ws);
    if (subscribers.size === 0) collector.setActive(false);
  }
  return {
    handle,
    close,
    dispose() {
      subscribers.clear();
      collector.stop();
      unsubscribe();
    },
    subscriberCount: () => subscribers.size,
  };
}
