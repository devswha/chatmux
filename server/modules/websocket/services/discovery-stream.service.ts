import type { WebSocket } from 'ws';

import type {
  DiscoveryCollector,
  DiscoveryLane,
  DiscoveryRow,
  DiscoverySnapshot,
} from '@/modules/providers/index.js';
import { WS_OPEN_STATE } from '@/modules/websocket/index.js';
import type { AnyRecord } from '@/shared/types.js';

export const MAX_QUEUED_MESSAGES = 64;
export const MAX_QUEUED_BYTES = 1_024 * 1_024;
export const MAX_BUFFERED_AMOUNT = 4 * 1_024 * 1_024;
export const SLOW_CLIENT_MS = 10_000;
export const DELTA_RING_SIZE = 256;
export const HEARTBEAT_CADENCE = 5;
export const RESYNC_WINDOW_MS = 10_000;
export const MAX_RESYNCS_PER_WINDOW = 3;

type Change =
  | { op: 'added'; row: DiscoveryRow }
  | { op: 'updated'; key: string; patch: Partial<DiscoveryRow> }
  | { op: 'stale'; key: string; since: number }
  | { op: 'removed'; key: string; reason: 'confirmed_gone' };

type Delta = Readonly<{ epoch: string; revision: number; prevRevision: number; changes: readonly Change[]; health: DiscoverySnapshot['health'] }>;
type Subscriber = {
  ws: WebSocket;
  lanes: readonly DiscoveryLane[];
  baselineRevision: number;
  queue: string[];
  queuedBytes: number;
  slowSince: number | null;
  resyncs: number[];
  awaitingResync: boolean;
};

function selected(snapshot: DiscoverySnapshot, lanes: readonly DiscoveryLane[]): DiscoverySnapshot {
  return { ...snapshot, rows: snapshot.rows.filter((row) => lanes.includes(row.lane)) };
}
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
function diff(previous: DiscoverySnapshot, next: DiscoverySnapshot): Change[] {
  const oldRows = new Map(previous.rows.map((row) => [row.key, row]));
  const changes: Change[] = [];
  for (const row of next.rows) {
    const old = oldRows.get(row.key);
    oldRows.delete(row.key);
    if (!old) { changes.push({ op: 'added', row }); continue; }
    if (old.presence !== 'stale' && row.presence === 'stale') { changes.push({ op: 'stale', key: row.key, since: row.staleSinceRevision ?? next.revision }); continue; }
    const patch: Record<string, unknown> = {};
    for (const key of Object.keys(row) as (keyof DiscoveryRow)[]) {
      if (key === 'key' || JSON.stringify(old[key]) === JSON.stringify(row[key])) continue;
      patch[key] = row[key];
    }
    if (Object.keys(patch).length) changes.push({ op: 'updated', key: row.key, patch });
  }
  for (const row of oldRows.values()) changes.push({ op: 'removed', key: row.key, reason: 'confirmed_gone' });
  return changes;
}

/** Discovery protocol fan-out. It only renders collector state; it is never an authorization input. */
export function createDiscoveryStream(collector: DiscoveryCollector, now = Date.now) {
  const subscribers = new Map<WebSocket, Subscriber>();
  const deltas: Delta[] = [];
  let previous = collector.currentSnapshot();
  let unchangedTicks = 0;
  const unsubscribe = collector.onSnapshot((snapshot) => {
    if (snapshot.revision === previous.revision) {
      unchangedTicks += 1;
      if (unchangedTicks % HEARTBEAT_CADENCE === 0) {
        for (const subscriber of subscribers.values()) {
          if (!subscriber.awaitingResync && subscriber.queue.length === 0) {
            enqueue(subscriber, { kind: 'discovery.heartbeat', epoch: snapshot.epoch, revision: snapshot.revision, takenAtMs: snapshot.takenAtMs });
          }
        }
      }
      previous = snapshot;
      return;
    }
    unchangedTicks = 0;
    const delta: Delta = { epoch: snapshot.epoch, revision: snapshot.revision, prevRevision: previous.revision, changes: diff(previous, snapshot), health: snapshot.health };
    previous = snapshot;
    deltas.push(delta);
    if (deltas.length > DELTA_RING_SIZE) deltas.shift();
    for (const subscriber of subscribers.values()) enqueueDelta(subscriber, delta);
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
  function enqueueDelta(subscriber: Subscriber, delta: Delta): void {
    if (subscriber.awaitingResync) {
      flush(subscriber);
      return;
    }
    if (delta.revision <= subscriber.baselineRevision) return;
    const changes = delta.changes.filter((change) => {
      const lane = change.op === 'added' ? change.row.lane : change.op === 'updated' ? change.patch.lane : undefined;
      return lane === undefined || subscriber.lanes.includes(lane as DiscoveryLane);
    });
    enqueue(subscriber, { kind: 'discovery.delta', ...delta, changes });
  }
  function snapshot(subscriber: Subscriber): void {
    const current = collector.currentSnapshot();
    subscriber.baselineRevision = current.revision;
    subscriber.awaitingResync = false;
    enqueue(subscriber, { kind: 'discovery.snapshot', ...selected(current, subscriber.lanes) });
  }
  function subscribe(ws: WebSocket, data: AnyRecord): void {
    if (data.protocolVersion !== 1) { send(ws, { kind: 'protocol_error', code: 'INVALID_PROTOCOL_VERSION', error: 'discovery.subscribe requires protocolVersion 1.' }); return; }
    const lanes = readLanes(data.lanes);
    if (!lanes) { send(ws, { kind: 'protocol_error', code: 'INVALID_DISCOVERY_LANES', error: 'Invalid discovery lanes.' }); return; }
    if (subscribers.has(ws)) subscribers.delete(ws);
    const subscriber: Subscriber = {
      ws,
      lanes,
      baselineRevision: collector.currentSnapshot().revision,
      queue: [],
      queuedBytes: 0,
      slowSince: null,
      resyncs: [],
      awaitingResync: false,
    };
    subscribers.set(ws, subscriber);
    const known = data.known as AnyRecord | null | undefined;
    const current = collector.currentSnapshot();
    if (known && known.epoch === current.epoch && known.revision === current.revision) {
      enqueue(subscriber, { kind: 'discovery.heartbeat', epoch: current.epoch, revision: current.revision, takenAtMs: current.takenAtMs });
    }
    else if (known && known.epoch === current.epoch && typeof known.revision === 'number') {
      const replay = deltas.filter((delta) => delta.revision > known.revision!);
      if (replay.length && replay[0]!.prevRevision === known.revision) { subscriber.baselineRevision = known.revision; for (const delta of replay) enqueueDelta(subscriber, delta); }
      else {
        enqueue(subscriber, { kind: 'discovery.resync_required', epoch: current.epoch, reason: 'replay_unavailable' });
        snapshot(subscriber);
      }
    } else snapshot(subscriber);
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
          snapshot(subscriber);
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
