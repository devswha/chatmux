import assert from 'node:assert/strict';
import test from 'node:test';

import { serviceWorkerRuntime } from './tests/support/service-worker-runtime.js';

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
    hostId: null,
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
    hostId: null,
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
    hostId: null,
    provider: 'claude',
    urlPath: '/session/legacy-session'
  }]);
  assert.deepEqual(runtime.openWindows, []);
});

const HOST_A = '11111111-1111-4111-8111-111111111111';

test('Given a host-qualified completion link, when clicked, then the owning host travels with the session id', async () => {
  // Given
  const runtime = await serviceWorkerRuntime();
  const messages: unknown[] = [];
  runtime.clients.push({
    url: 'https://chatmux.test/',
    focus: async () => {},
    navigate: async () => {},
    postMessage: (message: unknown) => { messages.push(message); },
  });

  // When
  await runtime.push({ title: 'Remote', tag: 'remote-one', navigation: { href: `/hosts/${HOST_A}/session/session-42` } });
  await runtime.click(runtime.notifications[0].options.data);

  // Then
  assert.deepEqual(JSON.parse(JSON.stringify(runtime.notifications[0].options.data.navigation)), {
    href: `/hosts/${HOST_A}/session/session-42`,
    sessionId: 'session-42',
    hostId: HOST_A,
  });
  assert.deepEqual(messages.map((message) => JSON.parse(JSON.stringify(message))), [{
    type: 'notification:navigate',
    sessionId: 'session-42',
    hostId: HOST_A,
    provider: null,
    urlPath: `/hosts/${HOST_A}/session/session-42`,
  }]);
});

test('Given a host-safe push payload, when clicked, then the service worker preserves its exact remote host route', async () => {
  const runtime = await serviceWorkerRuntime();
  const messages: unknown[] = [];
  runtime.clients.push({
    url: 'https://chatmux.test/', focus: async () => {}, navigate: async () => {},
    postMessage: (message: unknown) => { messages.push(message); },
  });
  const href = `/hosts/${HOST_A}/session/same%20session`;

  await runtime.push({
    title: 'Agent', body: 'studio-a · Claude: Reply ready', tag: 'host-safe-tag',
    navigation: { href, title: 'Agent', hostId: HOST_A, sessionId: 'same session' },
  });
  await runtime.click(runtime.notifications[0].options.data);

  assert.equal(runtime.notifications[0].options.tag, 'host-safe-tag');
  assert.deepEqual(messages.map((message) => JSON.parse(JSON.stringify(message))), [{
    type: 'notification:navigate', sessionId: 'same session', hostId: HOST_A,
    provider: null, urlPath: href,
  }]);
});

test('Given a malformed host segment, when a completion link is stored, then no session target is derived', async () => {
  // Given
  const runtime = await serviceWorkerRuntime();

  // When
  await runtime.push({ tag: 'bad-host', navigation: { href: '/hosts/not-a-host/session/session-42' } });

  // Then
  assert.deepEqual(JSON.parse(JSON.stringify(runtime.notifications[0].options.data.navigation)), {
    href: '/hosts/not-a-host/session/session-42',
    sessionId: null,
    hostId: null,
  });
});

test('Given a legacy local completion link, when stored, then it carries no host and stays local', async () => {
  // Given
  const runtime = await serviceWorkerRuntime();

  // When
  await runtime.push({ tag: 'local-one', navigation: { href: '/session/session-42' } });

  // Then
  assert.deepEqual(JSON.parse(JSON.stringify(runtime.notifications[0].options.data.navigation)), {
    href: '/session/session-42',
    sessionId: 'session-42',
    hostId: null,
  });
});
