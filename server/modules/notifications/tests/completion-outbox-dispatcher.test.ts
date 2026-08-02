import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createCompletionOutboxDispatcher,
  retryDelayMs,
} from '@/modules/notifications/services/completion-outbox-dispatcher.service.js';

const delivery = (id: number, attemptCount = 0) => ({
  id, outboxId: id, claimToken: `claim-${id}`, endpoint: `https://push.test/${id}`,
  p256dh: 'key',
  auth: 'auth',
  attemptCount,
  payload: {
    title: 'Reply ready',
    body: 'A reply is ready.',
    tag: `completion-${id}`,
    navigation: { href: '/', title: 'Open ChatMux' },
  },
});

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function store(batches: ReturnType<typeof delivery>[][]) {
  const calls: Array<[string, ...unknown[]]> = [];
  return {
    calls,
    claimDue: () => batches.shift() ?? [],
    prepareSend: (id: number, token: string) => { calls.push(['prepare', id, token]); return true; },
    acknowledge: (id: number, token: string, now: number) => { calls.push(['ack', id, token, now]); return true; },
    sentUnacknowledged: (id: number, token: string) => { calls.push(['sent-unacknowledged', id, token]); return true; },
    endpointGone: (id: number, token: string, now: number) => { calls.push(['gone', id, token, now]); return true; },
    permanentFailure: (id: number, token: string, errorClass: string) => { calls.push(['permanent', id, token, errorClass]); return true; },
    retry: (id: number, token: string, due: number, errorClass: string) => { calls.push(['retry', id, token, due, errorClass]); return true; },
  };
}

test('dispatcher acknowledges a successful push and does not send a lost claim', async () => {
  const outbox = store([[delivery(1), delivery(2)]]);
  outbox.prepareSend = (id: number, token: string) => { outbox.calls.push(['prepare', id, token]); return id === 1; };
  const sent: string[] = [];
  const dispatcher = createCompletionOutboxDispatcher({
    outbox, sendNotification: async ({ endpoint }) => { sent.push(endpoint); }, pollMs: 60_000,
  });
  dispatcher.wake();
  await settle();
  await dispatcher.stop();

  assert.deepEqual(sent, ['https://push.test/1']);
  assert.equal(outbox.calls.filter(([name]) => name === 'ack').length, 1);
});

test('dispatcher removes gone endpoints and classifies permanent and retryable transport failures', async () => {
  const cases = [
    [{ statusCode: 404 }, 'gone', ''], [{ statusCode: 410 }, 'gone', ''],
    [{ statusCode: 400 }, 'permanent', 'http_400'], [{ statusCode: 408 }, 'retry', 'http_408'],
    [{ statusCode: 425 }, 'retry', 'http_425'], [{ statusCode: 429 }, 'retry', 'http_429'],
    [{ statusCode: 503 }, 'retry', 'http_503'], [new Error('network'), 'retry', 'transport_error'],
  ] as const;
  for (const [error, expected, errorClass] of cases) {
    const outbox = store([[delivery(1, 2)]]);
    const dispatcher = createCompletionOutboxDispatcher({
      outbox, now: () => 10_000, pollMs: 60_000,
      sendNotification: async () => { throw error; },
    });
    dispatcher.wake();
    await settle();
    await dispatcher.stop();
    const operation = outbox.calls.find(([name]) => name === expected);
    assert.ok(operation, `${expected} classification`);
    if (expected === 'retry') assert.deepEqual(operation?.slice(3), [10_000 + retryDelayMs(3), errorClass]);
    if (expected === 'permanent') assert.equal(operation?.at(-1), errorClass);
  }
});

test('dispatcher drains full batches and coalesces wakes while a drain is active', async () => {
  const outbox = store([[delivery(1), delivery(2)], [delivery(3)], []]);
  let release!: () => void;
  const firstSend = new Promise<void>((resolve) => { release = resolve; });
  let sends = 0;
  const dispatcher = createCompletionOutboxDispatcher({
    outbox, maxClaims: 2, pollMs: 60_000,
    sendNotification: async () => { sends += 1; if (sends === 1) await firstSend; },
  });
  dispatcher.wake();
  await settle();
  dispatcher.wake();
  dispatcher.wake();
  release();
  await settle();
  await settle();
  await dispatcher.stop();

  assert.equal(sends, 3);
  assert.equal(outbox.calls.filter(([name]) => name === 'ack').length, 3);
});

test('dispatcher retries a transient acknowledgement failure without sending the push again', async () => {
  const outbox = store([[delivery(1)]]);
  let acknowledgementAttempts = 0;
  outbox.acknowledge = (id: number, token: string, now: number) => {
    acknowledgementAttempts += 1;
    outbox.calls.push(['ack', id, token, now]);
    if (acknowledgementAttempts === 1) throw new Error('database unavailable');
    return true;
  };
  let sends = 0;
  const dispatcher = createCompletionOutboxDispatcher({
    outbox, pollMs: 60_000, sendNotification: async () => { sends += 1; },
  });
  dispatcher.wake();
  await settle();
  await dispatcher.stop();

  assert.equal(sends, 1);
  assert.equal(acknowledgementAttempts, 2);
  assert.equal(outbox.calls.filter(([name]) => name === 'retry').length, 0);
});
test('dispatcher retries a false acknowledgement result without sending the push again', async () => {
  const outbox = store([[delivery(1)]]);
  let acknowledgementAttempts = 0;
  outbox.acknowledge = (id: number, token: string, now: number) => {
    acknowledgementAttempts += 1;
    outbox.calls.push(['ack', id, token, now]);
    return acknowledgementAttempts === 2;
  };
  let sends = 0;
  const dispatcher = createCompletionOutboxDispatcher({
    outbox, pollMs: 60_000, sendNotification: async () => { sends += 1; },
  });
  dispatcher.wake();
  await settle();
  await dispatcher.stop();

  assert.equal(sends, 1);
  assert.equal(acknowledgementAttempts, 2);
  assert.equal(outbox.calls.filter(([name]) => name === 'retry').length, 0);
});

test('dispatcher preserves a terminal acknowledgement conflict without resending', async () => {
  const outbox = store([[delivery(1)]]);
  const errors: unknown[] = [];
  outbox.acknowledge = (id: number, token: string, now: number) => {
    outbox.calls.push(['ack', id, token, now]);
    return false;
  };
  let sends = 0;
  const dispatcher = createCompletionOutboxDispatcher({
    outbox,
    pollMs: 60_000,
    sendNotification: async () => { sends += 1; },
    logError: (_message, error) => { errors.push(error); },
  });
  dispatcher.wake();
  await settle();
  await dispatcher.stop();

  assert.equal(sends, 1);
  assert.equal(outbox.calls.filter(([name]) => name === 'ack').length, 3);
  assert.equal(outbox.calls.filter(([name]) => name === 'retry').length, 0);
  assert.equal(errors.length, 1);
  assert.equal(outbox.calls.filter(([name]) => name === 'sent-unacknowledged').length, 1);
});

test('dispatcher acknowledges a send that resolves while stop is waiting', async () => {
  const outbox = store([[delivery(1)]]);
  let release!: () => void;
  const pendingSend = new Promise<void>((resolve) => { release = resolve; });
  let sends = 0;
  const dispatcher = createCompletionOutboxDispatcher({
    outbox,
    pollMs: 60_000,
    stopWaitMs: 1_000,
    sendNotification: async () => { sends += 1; await pendingSend; },
  });
  dispatcher.wake();
  await settle();

  const stopping = dispatcher.stop();
  release();
  await stopping;

  assert.equal(sends, 1);
  assert.equal(outbox.calls.filter(([name]) => name === 'ack').length, 1);
});

test('dispatcher stop clears its polling work and bounds an in-flight send wait', async () => {
  const outbox = store([[delivery(1)]]);
  const dispatcher = createCompletionOutboxDispatcher({
    outbox, pollMs: 60_000, stopWaitMs: 1, sendNotification: async () => new Promise<void>(() => {}),
  });
  dispatcher.wake();
  await settle();
  await dispatcher.stop();
  dispatcher.wake();
  await settle();

  assert.equal(outbox.calls.filter(([name]) => name === 'prepare').length, 1);
});
