import assert from 'node:assert/strict';
import test from 'node:test';

import { clearQueuedMessage, readQueuedMessage } from '../components/chat/utils/chatStorage';

import { clearHostIdentity } from './hostIdentity';
import { commonI18n, installBrowserGlobals } from './mountedBrowserEnvironment';
import { createDriver } from './mountedSessionDriver';
import {
  browserPersistedStateStorage,
  browserPersistedStateStorage as storagePort,
  IDENTITY_MARKER_KEY,
  LEGACY_QUEUED_MESSAGE_PREFIX,
  writeQueuedDraft,
} from './persistedHostState';
import { sessionRef } from './references';
import { sessionRoutePath } from './sessionRoute';
import HostNotFound from './view/HostNotFound';

const HOST_A = '11111111-1111-4111-8111-111111111111';
const HOST_B = '22222222-2222-4222-8222-222222222222';

test('Given a legacy local link, when the app opens it, then the local transcript loads through the legacy url', async (t) => {
  // Given
  const globals = installBrowserGlobals();
  const i18n = await commonI18n();
  const dispose: (() => Promise<void> | void)[] = [];
  t.after(async () => {
    for (const step of dispose) await step();
    globals.restore();
    clearHostIdentity();
  });
  const driver = createDriver({
    identity: HOST_A,
    i18n,
    messagesByUrl: new Map([['/api/providers/sessions/session-42/messages', ['local-1']]]),
  });
  dispose.push(driver.unmount);

  // When
  await driver.render('/session/session-42');

  // Then
  assert.equal(driver.state().routeKind, 'local-session');
  assert.equal(driver.state().localHostId, HOST_A);
  assert.deepEqual(driver.state().messageIds, ['local-1']);
  assert.ok(
    driver.requests.includes('/api/providers/sessions/session-42/messages?limit=10&offset=0'),
    'a local session keeps the legacy endpoint',
  );
});

test('Given a legacy queued draft, when the server supplies identity, then it migrates to the local host', async (t) => {
  // Given
  const globals = installBrowserGlobals();
  const i18n = await commonI18n();
  const dispose: (() => Promise<void> | void)[] = [];
  t.after(async () => {
    for (const step of dispose) await step();
    globals.restore();
    clearHostIdentity();
  });
  globals.entries.set(
    `${LEGACY_QUEUED_MESSAGE_PREFIX}session-42`,
    JSON.stringify({ content: 'draft written before the fleet existed' }),
  );
  const driver = createDriver({ identity: HOST_A, i18n, messagesByUrl: new Map() });
  dispose.push(driver.unmount);

  // When
  await driver.render('/session/session-42');

  // Then
  assert.equal(globals.entries.get(IDENTITY_MARKER_KEY), HOST_A);
  assert.equal(globals.entries.get(`${LEGACY_QUEUED_MESSAGE_PREFIX}session-42`), undefined);
  assert.equal(driver.state().draft, 'draft written before the fleet existed');
  const storage = browserPersistedStateStorage();
  assert.ok(storage);
  assert.equal(readQueuedMessage('session-42')?.content, 'draft written before the fleet existed');
});

test('Given two hosts sharing one session id, when both links are opened, then state never crosses hosts', async (t) => {
  // Given
  const globals = installBrowserGlobals();
  const i18n = await commonI18n();
  const dispose: (() => Promise<void> | void)[] = [];
  t.after(async () => {
    for (const step of dispose) await step();
    globals.restore();
    clearHostIdentity();
  });
  const driver = createDriver({
    identity: HOST_A,
    i18n,
    messagesByUrl: new Map([
      // A host-qualified URL naming the local host is a compatibility wrapper
      // over the local services, so both spellings serve host A's transcript.
      ['/api/providers/sessions/session-42/messages', ['on-host-a']],
      [`/api/hosts/${HOST_A}/providers/sessions/session-42/messages`, ['on-host-a']],
      [`/api/hosts/${HOST_B}/providers/sessions/session-42/messages`, ['on-host-b']],
    ]),
  });
  dispose.push(driver.unmount);

  // When
  await driver.render(`/hosts/${HOST_A}/session/session-42`);
  driver.writeDraft('draft for host a');
  driver.markProcessing();
  const hostAState = driver.state();

  await driver.render(`/hosts/${HOST_B}/session/session-42`);
  driver.writeDraft('draft for host b');
  const hostBState = driver.state();

  // Then
  assert.deepEqual(hostAState.messageIds, ['on-host-a']);
  assert.equal(hostAState.routeKind, 'local-session', 'the local host id canonicalises to the local view');
  assert.deepEqual(hostAState.processingLocalIds, ['session-42']);

  assert.deepEqual(hostBState.messageIds, ['on-host-b']);
  assert.equal(hostBState.routeKind, 'remote-session');
  assert.deepEqual(hostBState.processingLocalIds, [], 'a run on one host never appears on another');
  assert.equal(hostBState.draft, 'draft for host b');

  await driver.render(`/hosts/${HOST_A}/session/session-42`);
  assert.equal(driver.state().draft, 'draft for host a', 'each host keeps its own queued draft across navigation');
});

test('Given queued drafts on two hosts, when the page reloads, then each host restores its own draft', async (t) => {
  // Given
  const globals = installBrowserGlobals();
  const i18n = await commonI18n();
  const dispose: (() => Promise<void> | void)[] = [];
  t.after(async () => {
    for (const step of dispose) await step();
    globals.restore();
    clearHostIdentity();
  });
  const driver = createDriver({ identity: HOST_A, i18n, messagesByUrl: new Map() });
  dispose.push(driver.unmount);
  await driver.render(`/hosts/${HOST_B}/session/session-42`);
  driver.writeDraft('remote draft survives a reload');

  // When
  await driver.reload();

  // Then
  assert.equal(driver.state().draft, 'remote draft survives a reload');
  await driver.render('/session/session-42');
  assert.equal(driver.state().draft, null, 'the local session of the same id has no draft');
});

test('Given an unresolvable host segment, when the link is opened, then a dead end renders with no session load', async (t) => {
  // Given
  const globals = installBrowserGlobals();
  const i18n = await commonI18n();
  const dispose: (() => Promise<void> | void)[] = [];
  t.after(async () => {
    for (const step of dispose) await step();
    globals.restore();
    clearHostIdentity();
  });
  const driver = createDriver({
    identity: HOST_A,
    i18n,
    messagesByUrl: new Map([['/api/providers/sessions/session-42/messages', ['on-host-a']]]),
  });
  dispose.push(driver.unmount);

  // When
  await driver.render('/hosts/not-a-host/session/session-42');

  // Then
  const notFound = driver.root().root.findAllByType(HostNotFound);
  assert.equal(notFound.length, 1, 'the host-not-found surface replaces the session view');
  assert.equal(
    driver.root().root.findByProps({ 'data-testid': 'host-not-found-host-id' }).children.join(''),
    'not-a-host',
  );
  assert.deepEqual(
    driver.requests.filter((url) => url.includes('/messages')),
    [],
    'no fallback session request is made for an unknown host',
  );
});

test('Given a service-worker host link, when it is routed, then it resolves to that exact host', async (t) => {
  // Given
  const globals = installBrowserGlobals();
  const i18n = await commonI18n();
  const dispose: (() => Promise<void> | void)[] = [];
  t.after(async () => {
    for (const step of dispose) await step();
    globals.restore();
    clearHostIdentity();
  });
  const driver = createDriver({
    identity: HOST_A,
    i18n,
    messagesByUrl: new Map([[`/api/hosts/${HOST_B}/providers/sessions/session-42/messages`, ['on-host-b']]]),
  });
  dispose.push(driver.unmount);
  const notificationPath = sessionRoutePath(sessionRef(HOST_B, 'session-42'), HOST_A);

  // When
  await driver.render(notificationPath);

  // Then
  assert.equal(notificationPath, `/hosts/${HOST_B}/session/session-42`);
  assert.equal(driver.state().storeHostId, HOST_B);
  assert.deepEqual(driver.state().messageIds, ['on-host-b']);
});

test('Given a finished local run with a queued draft, when it leaves the processing map, then it is auto-sent once', async (t) => {
  // Given
  const globals = installBrowserGlobals();
  const i18n = await commonI18n();
  const dispose: (() => Promise<void> | void)[] = [];
  t.after(async () => {
    for (const step of dispose) await step();
    globals.restore();
    clearHostIdentity();
  });
  const driver = createDriver({ identity: HOST_A, i18n, messagesByUrl: new Map() });
  dispose.push(driver.unmount);
  await driver.render('/session/session-42');
  driver.writeDraft('auto-send me');
  driver.markProcessing();

  // When
  driver.markIdle();

  // Then
  assert.deepEqual(driver.sent, [{
    type: 'chat.send',
    sessionId: 'session-42',
    content: 'auto-send me',
    options: { images: [] },
  }]);
  assert.equal(driver.state().draft, null, 'the claimed draft is cleared exactly once');
  clearQueuedMessage('session-42');
});

test('Given drafts on two hosts, when the remote link opens, then the first composer read is the remote host draft', async (t) => {
  // Given
  const globals = installBrowserGlobals();
  const i18n = await commonI18n();
  const dispose: (() => Promise<void> | void)[] = [];
  t.after(async () => {
    for (const step of dispose) await step();
    globals.restore();
    clearHostIdentity();
  });
  const storage = storagePort();
  assert.ok(storage);
  writeQueuedDraft(storage, sessionRef(HOST_A, 'session-42'), { content: 'draft for host a' });
  writeQueuedDraft(storage, sessionRef(HOST_B, 'session-42'), { content: 'draft for host b' });
  const driver = createDriver({ identity: HOST_A, i18n, messagesByUrl: new Map() });
  dispose.push(driver.unmount);

  // When: the deep link to host B is the very first thing this browser opens.
  await driver.render(`/hosts/${HOST_B}/session/session-42`);

  // Then: the composer's lazy restore at mount saw host B's draft, never host A's.
  const firstMount = driver.mountReads.at(-1);
  assert.equal(firstMount?.sessionKey !== null, true);
  assert.equal(firstMount?.draft, 'draft for host b');
  assert.deepEqual(driver.sent, [], 'no draft is dispatched by opening the link');
});

test('Given two remote hosts with drafts, when navigating between them, then each mount reads its own host draft', async (t) => {
  // Given
  const globals = installBrowserGlobals();
  const i18n = await commonI18n();
  const dispose: (() => Promise<void> | void)[] = [];
  t.after(async () => {
    for (const step of dispose) await step();
    globals.restore();
    clearHostIdentity();
  });
  const storage = storagePort();
  assert.ok(storage);
  writeQueuedDraft(storage, sessionRef(HOST_A, 'session-42'), { content: 'draft for host a' });
  writeQueuedDraft(storage, sessionRef(HOST_B, 'session-42'), { content: 'draft for host b' });
  const driver = createDriver({ identity: HOST_A, i18n, messagesByUrl: new Map() });
  dispose.push(driver.unmount);
  await driver.render(`/hosts/${HOST_A}/session/session-42`);

  // When: the user opens the identically-named session on host B inside the app.
  await driver.navigate(`/hosts/${HOST_B}/session/session-42`);

  // Then: the surface remounted and its first read belongs to host B.
  const remount = driver.mountReads.at(-1);
  assert.notEqual(
    driver.mountReads.at(-2)?.sessionKey,
    remount?.sessionKey,
    'the host-qualified session key changes across hosts',
  );
  assert.equal(remount?.draft, 'draft for host b', 'the remounted composer restores host B draft');
  assert.deepEqual(driver.sent, [], 'navigating never dispatches a stored draft');

  // And: host A's draft is untouched by the switch.
  await driver.navigate(`/hosts/${HOST_A}/session/session-42`);
  assert.equal(driver.mountReads.at(-1)?.draft, 'draft for host a');
});
