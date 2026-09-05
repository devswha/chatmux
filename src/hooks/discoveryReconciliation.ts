type SendMessage = (message: unknown) => void;
type ResyncReason = 'gap' | 'epoch_mismatch' | 'client_error';
type DeferredRecovery = {
  reason: Exclude<ResyncReason, 'client_error'>;
  timer: number | null;
  attempted: boolean;
};

export const DISCOVERY_STALE_MS = 15_000;
const RESYNC_WINDOW_MS = 10_000;
// Stay below the server's three-resync limit, shared by both lane consumers.
const MAX_RESYNCS_PER_WINDOW = 2;

type PendingReads = {
  consumers: Set<{ onReadAdmitted: () => void }>;
  pendingSince: number | null;
  resyncs: number[];
  reconnectEvent: object | null;
  recovery: DeferredRecovery | null;
};

// Both lane hooks share one authenticated /ws subscription. Only read-request
// bookkeeping is shared here; rows and lane authority stay in useDiscoveryStream.
const readsByTransport = new WeakMap<SendMessage, PendingReads>();

export function acquireDiscoveryReconciliation(sendMessage: SendMessage, onReadAdmitted: () => void) {
  let reads = readsByTransport.get(sendMessage);
  if (!reads) {
    reads = { consumers: new Set(), pendingSince: null, resyncs: [], reconnectEvent: null, recovery: null };
    readsByTransport.set(sendMessage, reads);
  }
  const state = reads;
  const consumer = { onReadAdmitted };
  state.consumers.add(consumer);

  const hasPendingRead = () => state.pendingSince !== null
    && Date.now() - state.pendingSince <= DISCOVERY_STALE_MS;
  const cancelRecovery = () => {
    const timer = state.recovery?.timer;
    if (timer !== null && timer !== undefined) window.clearTimeout(timer);
    state.recovery = null;
  };
  const pruneResyncs = () => {
    state.resyncs = state.resyncs.filter((at) => Date.now() - at < RESYNC_WINDOW_MS);
  };
  const notifyReadAdmitted = () => {
    for (const current of state.consumers) current.onReadAdmitted();
  };
  const admitResync = (reason: ResyncReason) => {
    const now = Date.now();
    state.resyncs.push(now);
    state.pendingSince = now;
    notifyReadAdmitted();
    sendMessage({ type: 'discovery.resync', reason });
  };
  const recoveryDelay = () => {
    pruneResyncs();
    const pendingUntil = state.pendingSince === null ? 0 : state.pendingSince + DISCOVERY_STALE_MS + 1;
    const limitedUntil = state.resyncs.length < MAX_RESYNCS_PER_WINDOW ? 0 : state.resyncs[0] + RESYNC_WINDOW_MS;
    return Math.max(0, pendingUntil - Date.now(), limitedUntil - Date.now());
  };
  const deferRecovery = () => {
    const recovery = state.recovery;
    if (!recovery || recovery.attempted || recovery.timer !== null) return;
    // One deferred attempt per broken-sequence episode, not a request loop.
    // An admitted but unanswered read shares the same bounded retry. Subsequent
    // retries require an explicit refresh/foreground transition or a snapshot
    // establishing a new episode of stream authority.
    const timer = window.setTimeout(() => {
      if (state.recovery !== recovery || recovery.timer !== timer || state.consumers.size === 0) return;
      recovery.timer = null;
      // Another read or a clock change can move the admission boundary while
      // this timeout waits. Re-arm only the wait; do not spend a request early.
      if (recoveryDelay() > 0) {
        deferRecovery();
        return;
      }
      recovery.attempted = true;
      admitResync(recovery.reason);
    }, recoveryDelay());
    recovery.timer = timer;
  };

  return {
    hasPendingRead,
    subscribe(lanes: readonly string[], reconnectEvent?: object) {
      if (reconnectEvent && state.reconnectEvent !== reconnectEvent) {
        cancelRecovery();
        state.reconnectEvent = reconnectEvent;
        state.pendingSince = null;
        state.resyncs = [];
      }
      if (state.pendingSince !== null) return;
      state.pendingSince = Date.now();
      notifyReadAdmitted();
      // Authority was lost; an exact-known heartbeat cannot restore it.
      sendMessage({ type: 'discovery.subscribe', protocolVersion: 1, lanes, known: null });
    },
    resync(reason: ResyncReason, retryExpired = false): 'sent' | 'pending' | 'limited' {
      if (reason !== 'client_error' && !state.recovery) {
        state.recovery = { reason, timer: null, attempted: false };
      }
      if (state.pendingSince !== null
        && (!retryExpired || hasPendingRead())) {
        deferRecovery();
        return 'pending';
      }
      pruneResyncs();
      if (state.resyncs.length >= MAX_RESYNCS_PER_WINDOW) {
        deferRecovery();
        return 'limited';
      }
      admitResync(reason);
      deferRecovery();
      return 'sent';
    },
    acceptSnapshot() {
      cancelRecovery();
      state.pendingSince = null;
    },
    release() {
      state.consumers.delete(consumer);
      if (state.consumers.size === 0 && readsByTransport.get(sendMessage) === state) {
        cancelRecovery();
        readsByTransport.delete(sendMessage);
      }
    },
  };
}
