export type MonitorEventSubscriber<Event> = (
  listener: (event: Event) => void,
) => () => void;

export type EventDrivenMonitorLoopOptions<Event> = {
  tick: () => Promise<void>;
  subscribe: MonitorEventSubscriber<Event>;
  accepts: (event: Event) => boolean;
  fallbackMs?: number;
  quietMs?: number;
};

export const TURN_MONITOR_FALLBACK_MS = 2_000;
export const TURN_MONITOR_EVENT_QUIET_MS = 350;

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
}: EventDrivenMonitorLoopOptions<Event>): () => void {
  let stopped = false;
  let running = false;
  let pending = false;
  let eventBurstActive = false;
  let quietTimer: ReturnType<typeof setTimeout> | null = null;

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
    if (quietTimer) clearTimeout(quietTimer);
    quietTimer = setTimeout(() => {
      quietTimer = null;
      eventBurstActive = false;
      requestTick();
    }, quietMs);
    quietTimer.unref?.();
  });

  const fallbackTimer = setInterval(requestFallbackTick, fallbackMs);
  fallbackTimer.unref?.();
  requestTick();

  return () => {
    if (stopped) return;
    stopped = true;
    pending = false;
    clearInterval(fallbackTimer);
    if (quietTimer) clearTimeout(quietTimer);
    quietTimer = null;
    unsubscribe();
  };
}
