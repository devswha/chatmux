import assert from 'node:assert/strict';
import { test } from 'node:test';

import { queryClaudeSDK } from './claude-sdk.js';

type Notification = Record<string, unknown>;

function writer(appSessionId: string | undefined = 'app-session'): {
  userId: number;
  messages: unknown[];
  getAppSessionId(): string | undefined;
  send(message: unknown): void;
  setSessionId(_sessionId: string): void;
} {
  return {
    userId: 7,
    messages: [],
    getAppSessionId: () => appSessionId,
    send(message) { this.messages.push(message); },
    setSessionId() {},
  };
}

function stream(messages: unknown[]): AsyncIterable<unknown> {
  return (async function* () { yield* messages; })();
}

function runtime(query: () => AsyncIterable<unknown>, notifications: { stopped: Notification[]; failed: Notification[]; }): Record<string, unknown> {
  return {
    query,
    resolveResumeModel: async () => undefined,
    getProviderModels: async () => ({ models: {} }),
    loadMcpConfig: async () => null,
    isProviderInstalled: async () => true,
    notifyRunStopped: async (event: Notification) => { notifications.stopped.push(event); },
    notifyRunFailed: async (event: Notification) => { notifications.failed.push(event); },
    notifyUserIfEnabled: async () => {},
  };
}

test('Claude SDK completion notifies the validated app session exactly once', async () => {
  const notifications = { stopped: [] as Notification[], failed: [] as Notification[] };
  const ws = writer('app-123');
  await queryClaudeSDK('hello', { sessionId: 'provider-456', sessionSummary: 'Claude run' }, ws, runtime(
    () => stream([
      { type: 'result', subtype: 'success', uuid: 'completion-1', session_id: 'provider-456' },
      { type: 'result', subtype: 'success', uuid: 'completion-2', session_id: 'provider-456' },
    ]),
    notifications,
  ));

  assert.deepEqual(notifications.failed, []);
  assert.equal(notifications.stopped.length, 1);
  assert.deepEqual(notifications.stopped[0], {
    userId: 7,
    provider: 'claude',
    sessionId: 'app-123',
    sessionName: 'Claude run',
    stopReason: 'completed',
    completionKey: 'completion-2',
  });
  assert.equal((ws.messages.at(-1) as { sessionId?: string }).sessionId, 'provider-456');
});

test('Claude SDK provider result failures notify the app session', async () => {
  const notifications = { stopped: [] as Notification[], failed: [] as Notification[] };
  await queryClaudeSDK('hello', { sessionId: 'provider-456' }, writer('app-123'), runtime(
    () => stream([{ type: 'result', subtype: 'error_during_execution', errors: ['provider failed'], session_id: 'provider-456' }]),
    notifications,
  ));

  assert.deepEqual(notifications.stopped, []);
  assert.equal(notifications.failed.length, 1);
  assert.equal(notifications.failed[0].sessionId, 'app-123');
  assert.equal(notifications.failed[0].error, 'provider failed');
});

test('Claude SDK thrown query failures notify the app session', async () => {
  const notifications = { stopped: [] as Notification[], failed: [] as Notification[] };
  await queryClaudeSDK('hello', { sessionId: 'provider-456' }, writer('app-123'), runtime(
    () => { throw new Error('query failed'); },
    notifications,
  ));

  assert.equal(notifications.failed.length, 1);
  assert.equal(notifications.failed[0].sessionId, 'app-123');
  assert.equal((notifications.failed[0].error as Error).message, 'query failed');
});

test('Claude SDK skips terminal notifications without a valid app identity', async () => {
  const notifications = { stopped: [] as Notification[], failed: [] as Notification[] };
  await queryClaudeSDK('hello', { sessionId: 'provider-456', appSessionId: '  ' }, writer(''), runtime(
    () => stream([{ type: 'result', subtype: 'success', uuid: 'completion-1', session_id: 'provider-456' }]),
    notifications,
  ));

  assert.deepEqual(notifications, { stopped: [], failed: [] });
});

test('Claude SDK keeps rejected notification publication fail-soft and observable', async () => {
  const ws = writer('app-123');
  const errors: unknown[][] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => { errors.push(args); };
  try {
    await queryClaudeSDK('hello', { sessionId: 'provider-456' }, ws, {
      ...runtime(() => stream([{ type: 'result', subtype: 'success', uuid: 'completion-1', session_id: 'provider-456' }]), { stopped: [], failed: [] }),
      notifyRunStopped: async () => { throw new Error('publication rejected'); },
    });
    await new Promise(resolve => setImmediate(resolve));
  } finally {
    console.error = originalError;
  }

  assert.ok(errors.some(([message, error]) => message === '[Claude SDK] Notification publication failed:' && (error as Error).message === 'publication rejected'));
  assert.equal((ws.messages.at(-1) as { exitCode?: number }).exitCode, 0);
});
