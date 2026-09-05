import type { LLMProvider } from '@/shared/types.js';

export type SessionFileUpdate = {
  eventType: 'add' | 'change';
  filePath: string;
  provider: LLMProvider;
  signal?: AbortSignal;
};

export type SessionIndexReconciliationMode = 'incremental' | 'gap';

type PendingUpdate = SessionFileUpdate & { startedAtMs: number; readyAtMs: number };
type ProviderQueue = {
  pending: Map<string, PendingUpdate>;
  active: boolean;
  reconcile: boolean;
  reconcileMode: SessionIndexReconciliationMode;
  recoveryMode: SessionIndexReconciliationMode;
  reconcileAtMs: number;
  nextReconcileAtMs: number;
  recovery: AsyncGenerator<void> | null;
  preferFile: boolean;
};

// These limits apply downstream of the GJC client's separate 4,096-path queue.
export const INDEXING_MAX_PENDING_PER_PROVIDER = 64;
export const INDEXING_MAX_ACTIVE = 4;
export const INDEXING_RECONCILE_RETRY_MS = 60_000;

export type SessionIndexingDiagnostics = {
  pending: number;
  active: number;
  reconciling: number;
  reconciliationPending: number;
  maxPending: number;
  maxActive: number;
  overflowed: number;
  failures: number;
  closed: boolean;
};

type Options = {
  providers: readonly LLMProvider[];
  run: (update: SessionFileUpdate, signal: AbortSignal) => Promise<void>;
  reconcile: (provider: LLMProvider, signal: AbortSignal, mode: SessionIndexReconciliationMode) => AsyncGenerator<void>;
  maxPendingPerProvider?: number;
  maxActive?: number;
  debounceMs?: number;
  maxWaitMs?: number;
  reconcileRetryMs?: number;
  paused?: boolean;
  now?: () => number;
  schedule?: (callback: () => void, delayMs: number) => () => void;
};

function scheduleTimer(callback: () => void, delayMs: number): () => void {
  const timer = setTimeout(callback, delayMs);
  timer.unref();
  return () => clearTimeout(timer);
}

/**
 * One bounded queue per provider and one active operation per provider. A hot
 * provider cannot occupy another provider's pending capacity or all work slots.
 * Overflow retains only a provider recovery bit, never an extra list of paths.
 * Each reconciliation step shares these slots and alternates with live file
 * work in its lane; the iterator must yield after each indexed file, without
 * advancing (or filtering against) the shared startup scan cursor.
 */
export function createSessionIndexingScheduler(options: Options) {
  const providers = [...new Set(options.providers)];
  const maxPending = options.maxPendingPerProvider ?? INDEXING_MAX_PENDING_PER_PROVIDER;
  const maxActive = options.maxActive ?? INDEXING_MAX_ACTIVE;
  const debounceMs = options.debounceMs ?? 150;
  const maxWaitMs = options.maxWaitMs ?? 1_000;
  const retryMs = options.reconcileRetryMs ?? INDEXING_RECONCILE_RETRY_MS;
  if (!Number.isInteger(maxPending) || maxPending < 1 || !Number.isInteger(maxActive) || maxActive < 1) {
    throw new Error('Session indexing limits must be positive integers.');
  }
  const now = options.now ?? Date.now;
  const schedule = options.schedule ?? scheduleTimer;
  const queues = new Map<LLMProvider, ProviderQueue>(providers.map((provider) => [provider, {
    pending: new Map(), active: false, reconcile: false, reconcileAtMs: 0, nextReconcileAtMs: 0,
    recovery: null, preferFile: false, reconcileMode: 'gap', recoveryMode: 'gap',
  }]));
  const controller = new AbortController();
  const tasks = new Set<Promise<void>>();
  let paused = options.paused ?? false;
  let closed = false;
  let cancelTimer: (() => void) | null = null;
  let nextProvider = 0;
  let active = 0;
  let reconciling = 0;
  let overflowed = 0;
  let failures = 0;
  let closing: Promise<void> | null = null;

  function requestReconciliation(provider: LLMProvider, mode: SessionIndexReconciliationMode = 'gap'): void {
    const queue = queues.get(provider);
    if (closed || !queue) return;
    if (!queue.reconcile) {
      queue.reconcile = true;
      queue.reconcileMode = mode;
      queue.reconcileAtMs = Math.max(now(), queue.nextReconcileAtMs);
    } else if (mode === 'gap') {
      // A periodic tick must never downgrade a retained overflow obligation.
      queue.reconcileMode = 'gap';
    }
    arm();
  }

  function firstReady(queue: ProviderQueue): PendingUpdate | undefined {
    for (const entry of queue.pending.values()) {
      if (entry.readyAtMs <= now()) return entry;
    }
    return undefined;
  }

  function arm(): void {
    cancelTimer?.();
    cancelTimer = null;
    if (closed || paused || active >= maxActive) return;
    let due = Infinity;
    for (const queue of queues.values()) {
      if (queue.active) continue;
      if (queue.recovery) due = Math.min(due, now());
      if (queue.reconcile) due = Math.min(due, queue.reconcileAtMs);
      for (const entry of queue.pending.values()) due = Math.min(due, entry.readyAtMs);
    }
    if (due !== Infinity) {
      // Even already-ready work starts on another turn, leaving timers, health
      // reads and the authoritative discovery collector able to make progress.
      cancelTimer = schedule(pump, Math.max(0, due - now()));
    }
  }

  function launch(provider: LLMProvider, queue: ProviderQueue, entry?: PendingUpdate): void {
    queue.active = true;
    active += 1;
    if (entry) {
      queue.pending.delete(entry.filePath);
    } else {
      if (!queue.recovery) {
        queue.reconcile = false;
        queue.recoveryMode = queue.reconcileMode;
        queue.nextReconcileAtMs = now() + retryMs;
      }
      reconciling += 1;
    }
    const signal = entry?.signal
      ? AbortSignal.any([controller.signal, entry.signal])
      : controller.signal;
    const task = (async () => {
      try {
        signal.throwIfAborted();
        if (entry) {
          await options.run(entry, signal);
        } else {
          queue.recovery ??= options.reconcile(provider, signal, queue.recoveryMode);
          const step = await queue.recovery.next();
          if (step.done) queue.recovery = null;
        }
        // A watcher generation may expire while its indexer is awaiting I/O.
        signal.throwIfAborted();
      } catch {
        if (!entry && queue.recovery) {
          await queue.recovery.return(undefined).catch(() => {});
          queue.recovery = null;
        }
        if (!closed) {
          if (!signal.aborted) failures = Math.min(Number.MAX_SAFE_INTEGER, failures + 1);
          requestReconciliation(provider, entry ? 'gap' : queue.recoveryMode);
        }
      } finally {
        queue.preferFile = !entry;
        queue.active = false;
        active -= 1;
        if (!entry) reconciling -= 1;
      }
    })();
    tasks.add(task);
    void task.then(() => { tasks.delete(task); arm(); });
  }

  function pump(): void {
    cancelTimer = null;
    if (closed || paused) return;
    for (let offset = 0; offset < providers.length && active < maxActive; offset += 1) {
      const index = (nextProvider + offset) % providers.length;
      const provider = providers[index];
      const queue = queues.get(provider)!;
      if (queue.active) continue;
      const entry = firstReady(queue);
      const recoveryReady = queue.recovery || (queue.reconcile && queue.reconcileAtMs <= now());
      if (recoveryReady && (!entry || !queue.preferFile)) {
        launch(provider, queue);
      } else if (entry) {
        launch(provider, queue, entry);
      } else continue;
      // The next pump begins after the last provider admitted this turn.
      nextProvider = (index + 1) % providers.length;
      offset = -1;
    }
    arm();
  }

  function enqueue(update: SessionFileUpdate): void {
    const queue = queues.get(update.provider);
    if (closed || !queue || update.signal?.aborted) return;
    const time = now();
    const existing = queue.pending.get(update.filePath);
    if (existing) {
      if (update.eventType === 'add') existing.eventType = 'add';
      existing.signal = update.signal;
      existing.readyAtMs = Math.min(time + debounceMs, existing.startedAtMs + maxWaitMs);
    } else if (queue.pending.size < maxPending) {
      queue.pending.set(update.filePath, {
        ...update, startedAtMs: time, readyAtMs: time + Math.min(debounceMs, maxWaitMs),
      });
    } else {
      overflowed = Math.min(Number.MAX_SAFE_INTEGER, overflowed + 1);
      requestReconciliation(update.provider);
    }
    arm();
  }

  return {
    enqueue,
    requestReconciliation,
    start(): void { paused = false; arm(); },
    diagnostics(): SessionIndexingDiagnostics {
      let pending = 0;
      let reconciliationPending = 0;
      for (const queue of queues.values()) {
        pending += queue.pending.size;
        if (queue.reconcile || queue.recovery) reconciliationPending += 1;
      }
      return {
        pending, active, reconciling, reconciliationPending,
        maxPending: providers.length * maxPending, maxActive,
        overflowed, failures, closed,
      };
    },
    close(): Promise<void> {
      if (closing) return closing;
      closed = true;
      cancelTimer?.();
      cancelTimer = null;
      controller.abort();
      for (const queue of queues.values()) { queue.pending.clear(); queue.reconcile = false; }
      // Abort before draining: no later generation or publication can overtake
      // an older provider callback that does not support cancellable I/O.
      closing = Promise.allSettled([...tasks]).then(async () => {
        await Promise.allSettled([...queues.values()].map(async (queue) => {
          await queue.recovery?.return(undefined);
          queue.recovery = null;
        }));
      });
      return closing;
    },
  };
}
