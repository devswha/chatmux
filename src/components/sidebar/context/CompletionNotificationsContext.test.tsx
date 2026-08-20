import assert from 'node:assert/strict';
import test from 'node:test';

import { createElement } from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';

import type { CompletionNotificationDescriptor, CompletionNotificationDevice, CompletionNotificationTarget } from '../../../../shared/completion-notifications';
import { api } from '../../../utils/api';
import { useCompletionNotifications } from '../hooks/useCompletionNotifications';
import type { CompletionNotificationsHookApi } from '../types/types';

import {
  applicationServerKeysEqual,
  canCommitPassiveCompletionNotificationStatus,
  CompletionNotificationsProvider,
  completionNotificationDescriptorKey,
  completionNotificationReducer,
  startClickGatedPreparation,
} from './CompletionNotificationsContext';

test('VAPID subscription comparison detects stale application-server keys', () => {
  const expected = Uint8Array.from([4, 12, 28, 44]);
  assert.equal(applicationServerKeysEqual(expected.buffer, expected), true);

  const padded = Uint8Array.from([99, ...expected, 100]);
  assert.equal(applicationServerKeysEqual(padded.subarray(1, 5), expected), true);
  assert.equal(applicationServerKeysEqual(Uint8Array.from([4, 12, 28, 45]), expected), false);
  assert.equal(applicationServerKeysEqual(null, expected), false);
});

const device: CompletionNotificationDevice = {
  supported: true,
  registered: true,
  setupRequired: false,
  reason: null,
};

const descriptor = (sessionId: string): CompletionNotificationDescriptor => ({
  kind: 'app', provider: 'gjc', sessionId,
});
const target = (alias: string, watched = false): CompletionNotificationTarget => ({
  alias,
  kind: 'app',
  revision: 1,
  watched,
});
const statusRecord = (item: CompletionNotificationTarget) => ({
  item: { alias: item.alias, mappingState: 'one_active' as const, reason: 'eligible' as const, target: item },
  target: item,
});

const initial = () => ({ records: new Map(), globalPaused: false, device: null });
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

test('click-gated preparation starts before deferred status and preserves its consumed result', async () => {
  const events: string[] = [];
  const status = deferred<void>();
  const preparation = startClickGatedPreparation(async () => {
    events.push('prepare');
    return 'endpoint';
  }, new AbortController().signal);

  const afterStatus = status.promise.then(() => {
    events.push('status');
    return preparation.consume();
  });

  assert.deepEqual(events, ['prepare'], 'the click-gated factory runs synchronously before status awaits');
  status.resolve();
  assert.equal(await afterStatus, 'endpoint');
  assert.deepEqual(events, ['prepare', 'status']);
});

test('click-gated preparation owns immediate rejections and rethrows the original error on consume', async () => {
  const error = new Error('permission rejected');
  let unhandled: unknown;
  const onUnhandled = (reason: unknown) => { unhandled = reason; };
  process.once('unhandledRejection', onUnhandled);
  const preparation = startClickGatedPreparation(() => Promise.reject(error), new AbortController().signal);

  await new Promise<void>((resolve) => setImmediate(resolve));
  process.removeListener('unhandledRejection', onUnhandled);
  assert.equal(unhandled, undefined, 'the rejection is owned in the factory call turn');
  await assert.rejects(preparation.consume(), (received: unknown) => received === error);
});

test('click-gated preparation aborts and settles when abandoned', async () => {
  const pending = deferred<string>();
  let preparationSignal: AbortSignal | undefined;
  const preparation = startClickGatedPreparation((signal) => {
    preparationSignal = signal;
    return pending.promise;
  }, new AbortController().signal);

  preparation.abandon();

  assert.equal(preparationSignal?.aborted, true);
  await assert.rejects(preparation.consume(), (error: unknown) =>
    error instanceof DOMException && error.name === 'AbortError');
  pending.reject(new Error('late preparation rejection'));
});

test('completion notification descriptor keys are provider-scoped and length framed', () => {
  assert.notEqual(
    completionNotificationDescriptorKey({ kind: 'app', provider: 'ab', sessionId: 'c' }),
    completionNotificationDescriptorKey({ kind: 'app', provider: 'a', sessionId: 'bc' }),
  );
  assert.notEqual(completionNotificationDescriptorKey(descriptor('one')), completionNotificationDescriptorKey(descriptor('two')));
});

test('passive status batches only replace returned owners and preserve each owner pending state', () => {
  const first = target('first');
  const second = target('second', true);
  const firstKey = completionNotificationDescriptorKey(descriptor('first'));
  const secondKey = completionNotificationDescriptorKey(descriptor('second'));
  const pending = completionNotificationReducer(initial(), { type: 'pending', key: firstKey, pending: true });
  const result = completionNotificationReducer(pending, {
    type: 'status',
    records: new Map([[firstKey, statusRecord(first)], [secondKey, statusRecord(second)]]),
    globalPaused: false,
    device,
    reason: null,
  });

  assert.equal(result.records.get(firstKey)?.pending, true, 'a passive refresh does not clear an in-flight owner mutation');
  assert.equal(result.records.get(secondKey)?.target?.watched, true);
  assert.equal(result.records.size, 2, 'a batch retains every independently returned owner');
});
test('passive commits cannot overwrite or clear a key while its mutation is active', () => {
  assert.equal(
    canCommitPassiveCompletionNotificationStatus(true, true, true),
    false,
    'a stale passive success is not dispatched over an active mutation',
  );
  assert.equal(
    canCommitPassiveCompletionNotificationStatus(true, true, true),
    false,
    'a passive failure is not dispatched to clear the mutation pending state',
  );
  assert.equal(
    canCommitPassiveCompletionNotificationStatus(true, true, false),
    true,
    'a current passive read still commits once no mutation owns the key',
  );
  assert.equal(canCommitPassiveCompletionNotificationStatus(false, true, false), false);
  assert.equal(canCommitPassiveCompletionNotificationStatus(true, false, false), false);
});
test('a stale passive response from another descriptor cannot replace the device/global snapshot', () => {
  assert.equal(
    canCommitPassiveCompletionNotificationStatus(true, true, false, false),
    false,
  );
});
test('mutation status clears pending only when explicitly marked authoritative', () => {
  const key = completionNotificationDescriptorKey(descriptor('one'));
  const pending = completionNotificationReducer(initial(), { type: 'pending', key, pending: true });
  const mutation = completionNotificationReducer(pending, {
    type: 'status',
    records: new Map([[key, statusRecord(target('one', true))]]),
    globalPaused: false,
    device,
    reason: null,
    clearPending: true,
  });

  assert.equal(mutation.records.get(key)?.pending, false);
  assert.equal(mutation.records.get(key)?.target?.watched, true);
});
test('removing a final registration drops its cached owner record', () => {
  const key = completionNotificationDescriptorKey(descriptor('one'));
  const populated = completionNotificationReducer(initial(), {
    type: 'status',
    records: new Map([[key, statusRecord(target('one'))]]),
    globalPaused: false,
    device,
    reason: null,
  });
  const removed = completionNotificationReducer(populated, { type: 'remove', key });

  assert.equal(removed.records.has(key), false);
});

test('conflict and timeout errors remain owner-local while a CAS refresh commits authoritative target state', () => {
  const one = completionNotificationDescriptorKey(descriptor('one'));
  const two = completionNotificationDescriptorKey(descriptor('two'));
  const conflicted = completionNotificationReducer(initial(), { type: 'error', key: one, error: 'settings_changed' });
  const timedOut = completionNotificationReducer(conflicted, { type: 'error', key: two, error: 'timeout' });
  const refreshed = completionNotificationReducer(timedOut, {
    type: 'status',
    records: new Map([[one, statusRecord(target('one', true))]]),
    globalPaused: false,
    device,
    reason: 'settings_changed',
  });

  assert.equal(refreshed.records.get(one)?.error, 'settings_changed', 'the conflict remains visible after authoritative refresh');
  assert.equal(refreshed.records.get(two)?.error, 'timeout', 'an unrelated owner keeps its live announcement');
});

test('an owner reset cannot overwrite another key and carries global pause atomically with device state', () => {
  const one = completionNotificationDescriptorKey(descriptor('one'));
  const two = completionNotificationDescriptorKey(descriptor('two'));
  const withTwo = completionNotificationReducer(initial(), {
    type: 'status',
    records: new Map([[two, statusRecord(target('two', true))]]),
    globalPaused: false,
    device,
    reason: null,
  });
  const resetOne = completionNotificationReducer(withTwo, {
    type: 'status',
    records: new Map([[one, statusRecord(target('one'))]]),
    globalPaused: true,
    device: { ...device, registered: false, reason: 'endpoint_not_registered' },
    reason: 'permission_denied',
  });

  assert.equal(resetOne.records.get(one)?.error, null, 'an unwatched owner does not surface a passive permission denial');
  assert.equal(resetOne.records.get(two)?.target?.watched, true, 'the other key survives an owner reset');
  assert.equal(resetOne.globalPaused, true);
  assert.equal(resetOne.device?.registered, false);
});

test('a passive permission denial surfaces only on watched sessions', () => {
  const watchedKey = completionNotificationDescriptorKey(descriptor('watched'));
  const idleKey = completionNotificationDescriptorKey(descriptor('idle'));
  const refreshed = completionNotificationReducer(initial(), {
    type: 'status',
    records: new Map([
      [watchedKey, statusRecord(target('watched', true))],
      [idleKey, statusRecord(target('idle'))],
    ]),
    globalPaused: false,
    device,
    reason: 'permission_denied',
  });

  assert.equal(refreshed.records.get(watchedKey)?.error, 'permission_denied', 'a watched session keeps the actionable denial');
  assert.equal(refreshed.records.get(idleKey)?.error, null, 'an unwatched session stays quiet');
});

test('a passive stale VAPID check exposes repair only for existing watched targets', () => {
  const watchedKey = completionNotificationDescriptorKey(descriptor('watched'));
  const idleKey = completionNotificationDescriptorKey(descriptor('idle'));
  const refreshed = completionNotificationReducer(initial(), {
    type: 'status',
    records: new Map([
      [watchedKey, statusRecord(target('watched', true))],
      [idleKey, statusRecord(target('idle'))],
    ]),
    globalPaused: false,
    device,
    reason: null,
    deviceRepairRequired: true,
  });

  assert.equal(refreshed.records.get(watchedKey)?.deviceRepairRequired, true);
  assert.equal(
    refreshed.records.get(idleKey)?.deviceRepairRequired,
    false,
    'an unwatched row never advertises a device repair action',
  );
});


test('a failed device registration keeps a fresh watched subscription repairable on passive refresh', async () => {
  const expectedKey = Uint8Array.from([4, 12, 28, 44]);
  const staleKey = Uint8Array.from([4, 12, 28, 45]);
  const watchedTarget = target('watched', true);
  let currentSubscription: {
    endpoint: string;
    options: { applicationServerKey: BufferSource };
    unsubscribe: () => Promise<boolean>;
    toJSON: () => { endpoint: string; keys: { p256dh: string; auth: string } };
  } | null;
  let browserSubscriptions = 0;
  let serverRegistrations = 0;
  let permissionRequests = 0;
  let remainingServerRegistrationFailures = 1;
  const staleSubscription = {
    endpoint: 'https://push.example/stale',
    options: { applicationServerKey: staleKey },
    unsubscribe: async () => {
      currentSubscription = null;
      return true;
    },
    toJSON: () => ({ endpoint: 'https://push.example/stale', keys: { p256dh: 'stale-p256dh', auth: 'stale-auth' } }),
  };
  const freshSubscription = {
    endpoint: 'https://push.example/fresh',
    options: { applicationServerKey: expectedKey },
    unsubscribe: async () => false,
    toJSON: () => ({ endpoint: 'https://push.example/fresh', keys: { p256dh: 'fresh-p256dh', auth: 'fresh-auth' } }),
  };
  currentSubscription = staleSubscription;
  const registration = {
    pushManager: {
      getSubscription: async () => currentSubscription,
      subscribe: async () => {
        browserSubscriptions += 1;
        currentSubscription = freshSubscription;
        return freshSubscription;
      },
    },
  };
  const notificationApi = api.completionNotifications as unknown as {
    status: (descriptors: unknown, endpoint?: string, options?: unknown) => Promise<Response>;
    vapidPublicKey: (options?: unknown) => Promise<Response>;
    subscribe: (subscription: unknown, options?: unknown) => Promise<Response>;
    register: (subscription: unknown, options?: unknown) => Promise<Response>;
    setWatch: (mutation: unknown, endpoint?: string, options?: unknown) => Promise<Response>;
  };
  const originalApi = {
    status: notificationApi.status,
    vapidPublicKey: notificationApi.vapidPublicKey,
    subscribe: notificationApi.subscribe,
    register: notificationApi.register,
    setWatch: notificationApi.setWatch,
  };
  const globalDescriptors = new Map(
    ['window', 'document', 'navigator', 'Notification', 'PushManager'].map((name) => [
      name,
      Object.getOwnPropertyDescriptor(globalThis, name),
    ]),
  );
  const restoreGlobal = (name: string) => {
    const descriptor = globalDescriptors.get(name);
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  };
  Object.defineProperties(globalThis, {
    window: {
      configurable: true,
      value: {
        isSecureContext: true,
        setTimeout: (callback: () => void) => setTimeout(callback, 0),
        clearTimeout,
        addEventListener: () => {},
        removeEventListener: () => {},
        matchMedia: () => ({ matches: false }),
        Notification: {},
        PushManager: class PushManager {},
      },
    },
    document: {
      configurable: true,
      value: {
        visibilityState: 'visible',
        addEventListener: () => {},
        removeEventListener: () => {},
      },
    },
    navigator: {
      configurable: true,
      value: {
        userAgent: 'test browser',
        maxTouchPoints: 0,
        serviceWorker: {
          getRegistration: async () => registration,
          ready: Promise.resolve(registration),
        },
      },
    },
    Notification: {
      configurable: true,
      value: {
        permission: 'granted',
        requestPermission: async () => {
          permissionRequests += 1;
          return 'granted';
        },
      },
    },
    PushManager: { configurable: true, value: class PushManager {} },
  });
  notificationApi.status = async (_descriptors, endpoint) => new Response(JSON.stringify({
    globalPaused: false,
    targets: [{
      alias: watchedTarget.alias,
      mappingState: 'one_active',
      reason: 'eligible',
      target: watchedTarget,
    }],
    device: endpoint === freshSubscription.endpoint
      ? { ...device, registered: false, setupRequired: true, reason: 'endpoint_not_registered' }
      : device,
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  notificationApi.vapidPublicKey = async () => new Response(JSON.stringify({ publicKey: 'BAwcLA' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
  notificationApi.subscribe = async (subscription) => {
    serverRegistrations += 1;
    assert.deepEqual(subscription, {
      endpoint: freshSubscription.endpoint,
      keys: { p256dh: 'fresh-p256dh', auth: 'fresh-auth' },
    });
    if (remainingServerRegistrationFailures > 0) {
      remainingServerRegistrationFailures -= 1;
      return new Response('{}', { status: 503, headers: { 'content-type': 'application/json' } });
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  notificationApi.register = async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  notificationApi.setWatch = async () => new Response(JSON.stringify({
    target: watchedTarget,
    globalPaused: false,
    device,
  }), { status: 200, headers: { 'content-type': 'application/json' } });

  const snapshots: CompletionNotificationsHookApi[] = [];
  let renderer: ReactTestRenderer | null = null;
  function Probe() {
    snapshots.push(useCompletionNotifications(descriptor('watched')));
    return null;
  }

  try {
    await act(async () => {
      renderer = TestRenderer.create(createElement(
        CompletionNotificationsProvider,
        null,
        createElement(Probe),
      ));
      await tick();
      await tick();
      await tick();
    });
    const latest = snapshots.at(-1);
    assert.ok(latest);
    assert.equal(latest.status?.deviceRepairRequired, true, 'the passive refresh exposes a stale watched subscription');
    assert.equal(browserSubscriptions, 0, 'a passive stale-key refresh never changes the browser subscription');
    assert.equal(serverRegistrations, 0, 'a passive stale-key refresh never re-registers the device');
    assert.equal(permissionRequests, 0, 'a passive stale-key refresh never requests notification permission');

    await act(async () => {
      await latest.repairDevice(descriptor('watched'));
      await tick();
    });

    assert.equal(browserSubscriptions, 1, 'repair replaces the stale browser subscription only after the explicit action');
    assert.equal(serverRegistrations, 1, 'the first server registration attempt failed transiently');

    await act(async () => {
      await snapshots.at(-1)!.refresh();
      await tick();
    });
    const retry = snapshots.at(-1);
    assert.ok(retry);
    assert.equal(retry.status?.deviceRepairRequired, true, 'the unregistered fresh endpoint remains repairable after passive refresh');

    await act(async () => {
      await retry.repairDevice(descriptor('watched'));
      await tick();
    });
    assert.equal(browserSubscriptions, 1, 'retrying registration does not churn the matching browser subscription');
    assert.equal(serverRegistrations, 2, 'the explicit retry re-registers the fresh endpoint');
  } finally {
    if (renderer) await act(async () => { renderer!.unmount(); });
    notificationApi.status = originalApi.status;
    notificationApi.vapidPublicKey = originalApi.vapidPublicKey;
    notificationApi.subscribe = originalApi.subscribe;
    notificationApi.register = originalApi.register;
    notificationApi.setWatch = originalApi.setWatch;
    for (const name of globalDescriptors.keys()) restoreGlobal(name);
  }
});