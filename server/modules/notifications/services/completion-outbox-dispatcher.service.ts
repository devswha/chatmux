import { createRequire } from 'node:module';

import {
  completionNotificationOutboxDb,
} from '@/modules/database/index.js';

type ClaimedCompletionDelivery = ReturnType<typeof completionNotificationOutboxDb.claimDue>[number];
type CompletionOutboxStore = Pick<typeof completionNotificationOutboxDb,
  'claimDue' | 'prepareSend' | 'acknowledge' | 'sentUnacknowledged' | 'endpointGone' | 'permanentFailure' | 'retry'>;
type PushSender = (subscription: { endpoint: string; keys: { p256dh: string; auth: string } }, payload: string) => Promise<void>;
const require = createRequire(import.meta.url);
const webPush = require('web-push') as { sendNotification: PushSender };

const POLL_MS = 5_000;
const MAX_CLAIMS = 100;
const STOP_WAIT_MS = 5_000;
const MAX_ACKNOWLEDGEMENT_ATTEMPTS = 3;

function errorStatus(error: unknown): number | undefined {
  const status = (error as { statusCode?: unknown } | null)?.statusCode;
  return typeof status === 'number' ? status : undefined;
}

export function retryDelayMs(attemptCount: number): number {
  return Math.min(3_600_000, 5_000 * 2 ** Math.min(Math.max(attemptCount - 1, 0), 10));
}

export type CompletionOutboxDispatcher = {
  wake(): void;
  stop(): Promise<void>;
};

export type CompletionOutboxDispatcherDependencies = {
  outbox?: CompletionOutboxStore;
  sendNotification?: PushSender;
  now?: () => number;
  pollMs?: number;
  maxClaims?: number;
  stopWaitMs?: number;
  logError?: (message: string, error: unknown) => void;
};

let activeDispatcher: CompletionOutboxDispatcher | null = null;

export function wakeCompletionOutboxDispatcher(): void {
  activeDispatcher?.wake();
}

/**
 * Drains durable completion deliveries. SQLite is used only for short claim
 * transitions; the potentially slow Web Push request is always outside it.
 */
export function createCompletionOutboxDispatcher({
  outbox = completionNotificationOutboxDb,
  sendNotification = webPush.sendNotification,
  now = Date.now,
  pollMs = POLL_MS,
  maxClaims = MAX_CLAIMS,
  stopWaitMs = STOP_WAIT_MS,
  logError = console.error,
}: CompletionOutboxDispatcherDependencies = {}): CompletionOutboxDispatcher {
  let stopped = false;
  let draining: Promise<void> | null = null;
  let wakeQueued = false;
  let wakeRequested = false;

  const dispatch = async (delivery: ClaimedCompletionDelivery): Promise<void> => {
    if (!outbox.prepareSend(delivery.id, delivery.claimToken)) return;
    try {
      await sendNotification({
        endpoint: delivery.endpoint,
        keys: { p256dh: delivery.p256dh, auth: delivery.auth },
      }, JSON.stringify(delivery.payload));
    } catch (error) {
      const status = errorStatus(error);
      const errorClass = status === undefined ? 'transport_error' : `http_${status}`;
      if (status === 404 || status === 410) {
        outbox.endpointGone(delivery.id, delivery.claimToken, now());
      } else if (status !== undefined && status >= 400 && status < 500
        && status !== 408 && status !== 425 && status !== 429) {
        outbox.permanentFailure(delivery.id, delivery.claimToken, errorClass);
      } else {
        outbox.retry(
          delivery.id,
          delivery.claimToken,
          now() + retryDelayMs(delivery.attemptCount + 1),
          errorClass,
        );
      }
      return;
    }

    let acknowledgementError: unknown;
    for (let attempt = 0; attempt < MAX_ACKNOWLEDGEMENT_ATTEMPTS; attempt += 1) {
      try {
        if (outbox.acknowledge(delivery.id, delivery.claimToken, now()) === true) return;
        acknowledgementError = new Error('Acknowledgement conflict');
      } catch (error) {
        acknowledgementError = error;
      }
    }
    // The push has reached its provider. Persist a terminal outcome rather
    // than leaving an expired claim eligible for a second send.
    outbox.sentUnacknowledged(delivery.id, delivery.claimToken);
    if (acknowledgementError !== undefined) {
      logError('[Completion Outbox] Acknowledgement error:', acknowledgementError);
    }
  };

  const drain = (): void => {
    if (stopped) return;
    if (draining) {
      wakeRequested = true;
      return;
    }
    draining = (async () => {
      do {
        const deliveries = outbox.claimDue(now(), maxClaims);
        await Promise.all(deliveries.map(dispatch));
        if (deliveries.length < maxClaims) break;
      } while (!stopped);
    })().catch((error: unknown) => {
      logError('[Completion Outbox] Dispatch error:', error);
    }).finally(() => {
      draining = null;
      if (wakeRequested && !stopped) {
        wakeRequested = false;
        drain();
      }
    });
  };

  const timer = setInterval(drain, pollMs);
  timer.unref?.();
  const wake = (): void => {
    if (stopped || wakeQueued) return;
    wakeQueued = true;
    queueMicrotask(() => {
      wakeQueued = false;
      drain();
    });
  };
  const dispatcher: CompletionOutboxDispatcher = {
    wake,
    async stop(): Promise<void> {
      stopped = true;
      clearInterval(timer);
      if (draining) {
        let stopTimer: ReturnType<typeof setTimeout> | null = null;
        try {
          await Promise.race([
            draining,
            new Promise<void>((resolve) => {
              stopTimer = setTimeout(resolve, stopWaitMs);
            }),
          ]);
        } finally {
          if (stopTimer) clearTimeout(stopTimer);
        }
      }
      if (activeDispatcher === dispatcher) activeDispatcher = null;
    },
  };
  return dispatcher;
}

export function startCompletionOutboxDispatcher(): CompletionOutboxDispatcher {
  if (activeDispatcher) return activeDispatcher;
  const dispatcher = createCompletionOutboxDispatcher();
  activeDispatcher = dispatcher;
  dispatcher.wake();
  return dispatcher;
}
