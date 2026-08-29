export type MonitorEventSubscriber<Event> = (
  listener: (event: Event) => void,
) => () => void;

export interface MonitorLoopScheduledTask {
  cancel(): void;
}

export interface MonitorLoopScheduler {
  schedule(delayMs: number, callback: () => void): MonitorLoopScheduledTask;
  repeat(intervalMs: number, callback: () => void): MonitorLoopScheduledTask;
}

export type EventDrivenMonitorLoopOptions<Event> = {
  readonly tick: () => Promise<void>;
  readonly subscribe: MonitorEventSubscriber<Event>;
  readonly accepts: (event: Event) => boolean;
  readonly fallbackMs?: number;
  readonly quietMs?: number;
  readonly scheduler?: MonitorLoopScheduler;
};

export const TURN_MONITOR_FALLBACK_MS = 2_000;
export const TURN_MONITOR_EVENT_QUIET_MS = 350;

const defaultMonitorScheduler: MonitorLoopScheduler = {
  schedule(delayMs, callback) {
    const timer = setTimeout(callback, delayMs);
    timer.unref?.();
    return { cancel: () => { clearTimeout(timer); } };
  },
  repeat(intervalMs, callback) {
    const timer = setInterval(callback, intervalMs);
    timer.unref?.();
    return { cancel: () => { clearInterval(timer); } };
  },
};

/**
 * Runs at startup, on the leading and settled edges of a relevant event burst,
 * and periodically as a missed-event fallback. Concurrent requests collapse
 * into one queued follow-up instead of overlapping.
 */
export function startEventDrivenMonitorLoop<Event>({
  tick,
  subscribe,
  accepts,
  fallbackMs = TURN_MONITOR_FALLBACK_MS,
  quietMs = TURN_MONITOR_EVENT_QUIET_MS,
  scheduler = defaultMonitorScheduler,
}: EventDrivenMonitorLoopOptions<Event>): () => void {
  let stopped = false;
  let running = false;
  let pending = false;
  let eventBurstActive = false;
  let quietTimer: MonitorLoopScheduledTask | null = null;

  const drain = async (): Promise<void> => {
    if (running || stopped) return;
    running = true;
    try {
      do {
        pending = false;
        await tick().catch(() => {});
      } while (pending && !stopped);
    } finally {
      running = false;
      if (pending && !stopped) void drain();
    }
  };

  const requestTick = (): void => {
    if (stopped) return;
    pending = true;
    void drain();
  };

  const requestFallbackTick = (): void => {
    if (running) return;
    requestTick();
  };

  const unsubscribe = subscribe((event) => {
    if (stopped || !accepts(event)) return;
    if (!eventBurstActive) {
      eventBurstActive = true;
      requestTick();
    }
    quietTimer?.cancel();
    quietTimer = scheduler.schedule(quietMs, () => {
      quietTimer = null;
      eventBurstActive = false;
      requestTick();
    });
  });

  const fallbackTimer = scheduler.repeat(fallbackMs, requestFallbackTick);
  requestTick();

  return () => {
    if (stopped) return;
    stopped = true;
    pending = false;
    fallbackTimer.cancel();
    quietTimer?.cancel();
    quietTimer = null;
    unsubscribe();
  };
}
