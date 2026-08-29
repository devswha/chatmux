import assert from 'node:assert/strict';
import test from 'node:test';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { sessionSlotKey } from '../fleet/references';

import { type SessionStoreScope } from './sessionStoreScope';
import { type SessionStore, useSessionStore } from './useSessionStore';

const HOST_A = '11111111-1111-4111-8111-111111111111';
const HOST_B = '22222222-2222-4222-8222-222222222222';

type PendingRequest = {
  url: string;
  resolve: (response: Response) => void;
};

function response(data: unknown): Response {
  return new Response(JSON.stringify({ data }), { status: 200 });
}

function createStore(scope?: SessionStoreScope): SessionStore {
  let store: SessionStore | undefined;
  function StoreHarness() {
    store = useSessionStore(scope);
    return null;
  }
  renderToStaticMarkup(createElement(StoreHarness));
  assert.ok(store);
  return store;
}

function stubFetch(): { pending: PendingRequest[]; restore: () => void } {
  const originalFetch = globalThis.fetch;
  const pending: PendingRequest[] = [];
  globalThis.fetch = ((url: string) => new Promise<Response>((resolve) => {
    pending.push({ url, resolve });
  })) as typeof fetch;
  return { pending, restore: () => { globalThis.fetch = originalFetch; } };
}

const message = (id: string, sessionId: string) => ({
  id,
  sessionId,
  timestamp: '2026-01-01T00:00:00Z',
  kind: 'text',
  provider: 'claude',
});

test('Given one local id on two hosts, when each store fetches, then transcripts stay independent', async (t) => {
  // Given
  const fetchStub = stubFetch();
  t.after(fetchStub.restore);
  const onA = createStore({ hostId: HOST_A, localHostId: HOST_A });
  const onB = createStore({ hostId: HOST_B, localHostId: HOST_A });

  // When
  const fetchedA = onA.fetchFromServer('session-42');
  const fetchedB = onB.fetchFromServer('session-42');
  fetchStub.pending.shift()!.resolve(response({ messages: [message('a-1', 'session-42')], total: 1 }));
  fetchStub.pending.shift()!.resolve(response({ messages: [message('b-1', 'session-42')], total: 1 }));
  await Promise.all([fetchedA, fetchedB]);

  // Then
  assert.deepEqual(onA.getMessages('session-42').map((entry) => entry.id), ['a-1']);
  assert.deepEqual(onB.getMessages('session-42').map((entry) => entry.id), ['b-1']);
  assert.ok(onA.getSessionSlot('session-42'));
  assert.ok(onB.getSessionSlot('session-42'));
});

test('Given a remote host scope, when messages are requested, then the url is host-qualified', async (t) => {
  // Given
  const fetchStub = stubFetch();
  t.after(fetchStub.restore);
  const remote = createStore({ hostId: HOST_B, localHostId: HOST_A });

  // When
  const fetched = remote.fetchFromServer('session-42', { limit: 2 });
  const messagesUrl = fetchStub.pending[0].url;
  fetchStub.pending.shift()!.resolve(response({ messages: [], total: 0, hasMore: true }));
  await fetched;
  const refreshed = remote.refreshFromServer('session-42');
  const refreshUrl = fetchStub.pending[0].url;
  fetchStub.pending.shift()!.resolve(response({ messages: [], total: 0 }));
  await refreshed;

  // Then
  assert.equal(messagesUrl, `/api/hosts/${HOST_B}/providers/sessions/session-42/messages?limit=2&offset=0`);
  assert.match(refreshUrl, new RegExp(`^/api/hosts/${HOST_B}/providers/sessions/session-42/messages\\?limit=`));
});

test('Given a local host scope, when messages are requested, then the legacy url is preserved', async (t) => {
  // Given
  const fetchStub = stubFetch();
  t.after(fetchStub.restore);
  const local = createStore({ hostId: HOST_A, localHostId: HOST_A });
  const legacy = createStore();

  // When
  const fetchedLocal = local.fetchFromServer('session-42', { limit: 2 });
  const localUrl = fetchStub.pending[0].url;
  fetchStub.pending.shift()!.resolve(response({ messages: [], total: 0 }));
  await fetchedLocal;
  const fetchedLegacy = legacy.fetchFromServer('session-42', { limit: 2 });
  const legacyUrl = fetchStub.pending[0].url;
  fetchStub.pending.shift()!.resolve(response({ messages: [], total: 0 }));
  await fetchedLegacy;

  // Then
  assert.equal(localUrl, '/api/providers/sessions/session-42/messages?limit=2&offset=0');
  assert.equal(legacyUrl, '/api/providers/sessions/session-42/messages?limit=2&offset=0');
});

test('Given realtime frames for the same local id on two hosts, when appended, then each slot keeps its own rows', () => {
  // Given
  const onA = createStore({ hostId: HOST_A, localHostId: HOST_A });
  const onB = createStore({ hostId: HOST_B, localHostId: HOST_A });

  // When
  onA.appendRealtime('session-42', { ...message('live-a', 'session-42'), kind: 'text', provider: 'claude' });
  onB.appendRealtime('session-42', { ...message('live-b', 'session-42'), kind: 'text', provider: 'claude' });

  // Then
  assert.deepEqual(onA.getMessages('session-42').map((entry) => entry.id), ['live-a']);
  assert.deepEqual(onB.getMessages('session-42').map((entry) => entry.id), ['live-b']);
});

test('Given a host-qualified slot, when it is inspected, then the store keys it by the qualified key', () => {
  // Given
  const store = createStore({ hostId: HOST_B, localHostId: HOST_A });

  // When
  store.appendRealtime('session-42', { ...message('live-b', 'session-42'), kind: 'text', provider: 'claude' });

  // Then
  assert.equal(store.has('session-42'), true);
  assert.notEqual(sessionSlotKey(HOST_B, 'session-42'), sessionSlotKey(HOST_A, 'session-42'));
  assert.equal(store.getMessages('session-42')[0].sessionId, 'session-42', 'rows keep the local id the host knows');
});
