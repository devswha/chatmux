import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createContext, runInContext } from 'node:vm';

type ServiceWorkerEvent = (event: any) => void;

type NotificationRecord = {
  title: unknown;
  options: any;
};

async function serviceWorkerRuntime() {
  const source = await readFile(new URL('../public/sw.js', import.meta.url), 'utf8');
  const listeners = new Map<string, ServiceWorkerEvent>();
  const notifications: NotificationRecord[] = [];
  const clients: any[] = [];
  const openWindows: string[] = [];
  const self = {
    addEventListener(type: string, listener: ServiceWorkerEvent) {
      listeners.set(type, listener);
    },
    location: { origin: 'https://chatmux.test' },
    registration: {
      showNotification(title: unknown, options: any) {
        notifications.push({ title, options });
        return Promise.resolve();
      },
    },
    clients: {
      claim() {},
      matchAll: async () => clients,
      openWindow: async (target: string) => { openWindows.push(target); },
    },
    skipWaiting() {},
  };

  runInContext(source, createContext({ self, URL }));

  async function push(payload: unknown) {
    let completion: Promise<unknown> | undefined;
    listeners.get('push')!({
      data: { json: () => payload },
      waitUntil(value: Promise<unknown>) { completion = Promise.resolve(value); },
    });
    await completion;
  }

  async function click(data: unknown) {
    let completion: Promise<unknown> | undefined;
    listeners.get('notificationclick')!({
      notification: {
        data,
        close() {},
      },
      waitUntil(value: Promise<unknown>) { completion = Promise.resolve(value); },
    });
    await completion;
  }

  return { click, clients, notifications, openWindows, push };
}

test('service worker preserves distinct top-level completion tags', async () => {
  const runtime = await serviceWorkerRuntime();

  await runtime.push({ title: 'First', body: 'Ready', tag: 'completion-one', navigation: { href: '/session/one' } });
  await runtime.push({ title: 'Second', body: 'Ready', tag: 'completion-two', navigation: { href: '/session/two' } });

  assert.deepEqual(runtime.notifications.map(({ options }) => options.tag), ['completion-one', 'completion-two']);
  assert.deepEqual(runtime.notifications.map(({ options }) => options.data.navigation.href), ['/session/one', '/session/two']);
});

test('service worker preserves legacy payload.data notifications', async () => {
  const runtime = await serviceWorkerRuntime();
  const data = { tag: 'legacy-tag', sessionId: 'legacy-session', provider: 'claude' };

  await runtime.push({ title: 'Legacy', body: 'Reply ready', data });

  assert.equal(runtime.notifications[0].title, 'Legacy');
  assert.equal(runtime.notifications[0].options.tag, 'legacy-tag');
  assert.equal(runtime.notifications[0].options.data, data);
});
test('service worker keeps malformed completion tags out of legacy handling', async () => {
  const runtime = await serviceWorkerRuntime();

  await runtime.push({
    tag: '',
    navigation: { href: '/session/empty-tag' },
    data: { tag: 'legacy-tag', sessionId: 'legacy-session' }
  });
  await runtime.push({ navigation: { href: '/session/missing-tag' } });
  await runtime.push({ tag: 42, navigation: { href: '/session/non-string-tag' } });
  await runtime.push({ tag: 'x'.repeat(257), navigation: { href: '/session/oversized-tag' } });

  assert.deepEqual(
    runtime.notifications.map(({ options }) => options.data.navigation.href),
    ['/session/empty-tag', '/session/missing-tag', '/session/non-string-tag', '/session/oversized-tag']
  );
  assert.deepEqual(runtime.notifications.map(({ options }) => options.tag), [undefined, undefined, undefined, undefined]);
  assert.deepEqual(runtime.notifications.map(({ options }) => options.renotify), [false, false, false, false]);
});

test('service worker falls back from invalid completion titles and navigation targets', async () => {
  const runtime = await serviceWorkerRuntime();

  await runtime.push({
    title: 'x'.repeat(257),
    tag: 'invalid-relative',
    navigation: { href: 'session/missing-leading-slash' },
  });
  await runtime.push({
    title: 'External',
    tag: 'external-target',
    navigation: { href: 'https://outside.test/session' },
  });

  assert.equal(runtime.notifications[0].title, 'ChatMux');
  assert.deepEqual(runtime.notifications.map(({ options }) => options.data.navigation.href), ['/', '/']);
});

test('completion notification clicks navigate a focused client or open the target', async () => {
  const focusedRuntime = await serviceWorkerRuntime();
  const calls: string[] = [];
  const messages: unknown[] = [];
  focusedRuntime.clients.push({
    url: 'https://chatmux.test/',
    focus: async () => { calls.push('focus'); },
    navigate: async (target: string) => { calls.push(`navigate:${target}`); },
    postMessage: (message: unknown) => { messages.push(message); },
  });

  await focusedRuntime.push({ navigation: { href: '/session/focused' } });
  await focusedRuntime.click(focusedRuntime.notifications[0].options.data);

  assert.deepEqual(calls, ['focus', 'navigate:/session/focused']);
  assert.deepEqual(messages.map((message) => JSON.parse(JSON.stringify(message))), [{
    type: 'notification:navigate',
    sessionId: 'focused',
    provider: null,
    urlPath: '/session/focused',
  }]);
  assert.deepEqual(focusedRuntime.openWindows, []);

  const rejectedRuntime = await serviceWorkerRuntime();
  const rejectedMessages: unknown[] = [];
  rejectedRuntime.clients.push({
    url: 'https://chatmux.test/',
    focus: async () => {},
    navigate: async () => { throw new Error('navigation rejected'); },
    postMessage: (message: unknown) => { rejectedMessages.push(message); },
  });

  await rejectedRuntime.push({ navigation: { href: '/session/rejected' } });
  await rejectedRuntime.click(rejectedRuntime.notifications[0].options.data);

  assert.equal((rejectedMessages[0] as { sessionId?: unknown })?.sessionId, 'rejected');
  assert.deepEqual(rejectedRuntime.openWindows, []);

  const openRuntime = await serviceWorkerRuntime();
  openRuntime.clients.push({ url: 'https://chatmux.test.attacker.test/', focus: async () => {}, navigate: async () => {} });

  await openRuntime.click({ navigation: { href: '/session/opened' } });

  assert.deepEqual(openRuntime.openWindows, ['/session/opened']);
});

test('legacy completion clicks recover the session id from navigation href', async () => {
  const runtime = await serviceWorkerRuntime();
  const messages: unknown[] = [];
  runtime.clients.push({
    url: 'https://chatmux.test/',
    focus: async () => {},
    navigate: async () => { throw new Error('navigation rejected'); },
    postMessage: (message: unknown) => { messages.push(message); },
  });

  // Older service workers persisted completion notifications without the
  // derived navigation.sessionId field.
  await runtime.click({ navigation: { href: '/session/legacy%20completion' } });

  assert.deepEqual(messages.map((message) => JSON.parse(JSON.stringify(message))), [{
    type: 'notification:navigate',
    sessionId: 'legacy completion',
    provider: null,
    urlPath: '/session/legacy%20completion',
  }]);
});
test('legacy notification clicks focus an exact-origin client and post navigation details', async () => {
  const runtime = await serviceWorkerRuntime();
  const messages: unknown[] = [];
  let focused = false;
  runtime.clients.push({
    url: 'https://chatmux.test/session/current',
    focus: async () => { focused = true; },
    postMessage: (message: unknown) => { messages.push(message); }
  });

  await runtime.click({ sessionId: 'legacy-session', provider: 'claude' });

  assert.equal(focused, true);
  assert.deepEqual(messages.map((message) => JSON.parse(JSON.stringify(message))), [{
    type: 'notification:navigate',
    sessionId: 'legacy-session',
    provider: 'claude',
    urlPath: '/session/legacy-session'
  }]);
  assert.deepEqual(runtime.openWindows, []);
});
