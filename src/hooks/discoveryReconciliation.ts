type SendMessage = (message: unknown) => void;
type ResyncReason = 'gap' | 'epoch_mismatch' | 'client_error';

export const DISCOVERY_STALE_MS = 15_000;
const RESYNC_WINDOW_MS = 10_000;
// Stay below the server's three-resync limit, shared by both lane consumers.
const MAX_RESYNCS_PER_WINDOW = 2;

type PendingReads = {
  consumers: Set<object>;
  pendingSince: number | null;
  resyncs: number[];
  reconnectEvent: object | null;
};

// Both lane hooks share one authenticated /ws subscription. Only read-request
// bookkeeping is shared here; rows and lane authority stay in useDiscoveryStream.
const readsByTransport = new WeakMap<SendMessage, PendingReads>();

export function acquireDiscoveryReconciliation(sendMessage: SendMessage) {
  let reads = readsByTransport.get(sendMessage);
  if (!reads) {
    reads = { consumers: new Set(), pendingSince: null, resyncs: [], reconnectEvent: null };
    readsByTransport.set(sendMessage, reads);
  }
  const state = reads;
  const consumer = {};
  state.consumers.add(consumer);

  return {
    subscribe(lanes: readonly string[], reconnectEvent?: object) {
      if (reconnectEvent && state.reconnectEvent !== reconnectEvent) {
        state.reconnectEvent = reconnectEvent;
        state.pendingSince = null;
        state.resyncs = [];
      }
      if (state.pendingSince !== null) return;
      state.pendingSince = Date.now();
      // Authority was lost; an exact-known heartbeat cannot restore it.
      sendMessage({ type: 'discovery.subscribe', protocolVersion: 1, lanes, known: null });
    },
    resync(reason: ResyncReason, retryExpired = false): 'sent' | 'pending' | 'limited' {
      const now = Date.now();
      if (state.pendingSince !== null
        && (!retryExpired || now - state.pendingSince <= DISCOVERY_STALE_MS)) return 'pending';
      state.resyncs = state.resyncs.filter((at) => now - at < RESYNC_WINDOW_MS);
      if (state.resyncs.length >= MAX_RESYNCS_PER_WINDOW) return 'limited';
      state.resyncs.push(now);
      state.pendingSince = now;
      sendMessage({ type: 'discovery.resync', reason });
      return 'sent';
    },
    acceptSnapshot() {
      state.pendingSince = null;
    },
    release() {
      state.consumers.delete(consumer);
      if (state.consumers.size === 0 && readsByTransport.get(sendMessage) === state) {
        readsByTransport.delete(sendMessage);
      }
    },
  };
}
