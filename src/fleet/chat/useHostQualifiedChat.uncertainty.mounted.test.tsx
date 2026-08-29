import assert from 'node:assert/strict';
import test from 'node:test';

import {
  dropAndSettle,
  mountChat,
  PEER_A,
  serverMessage,
  SESSION,
  stubFetch,
} from './hostQualifiedChat.testSupport';

test('Given a dispatched send, when the host connection drops before acknowledgement, then the state is non-success and reconciles from host history', async (t) => {
  // Given
  const idled: string[] = [];
  const fetches = stubFetch();
  t.after(fetches.restore);
  const harness = mountChat({ hostId: PEER_A, onIdle: (sessionId) => idled.push(String(sessionId)) });
  t.after(harness.dispose);
  fetches.reply({ messages: [serverMessage('peer-1', 'uncertain prompt')], total: 1 });
  harness.store().appendRealtime(SESSION, {
    ...serverMessage('local_uncertain', 'uncertain prompt'),
    timestamp: new Date().toISOString(),
  });
  harness.chat().sendMessage({ type: 'chat.send', sessionId: SESSION, content: 'uncertain prompt' });
  const socket = harness.remoteSockets[0];
  assert.ok(socket);
  socket.open();

  // When
  await dropAndSettle(harness, socket.drop);

  // Then
  assert.deepEqual(idled, [SESSION]);
  assert.deepEqual(harness.chat().uncertainty, {
    hostId: PEER_A,
    sessionId: SESSION,
    operation: 'chat.send',
    status: 'reconciled',
    evidence: 'applied',
  });
  assert.ok(fetches.urls.some((url) => url.startsWith(`/api/hosts/${PEER_A}/providers/sessions/${SESSION}/messages`)));
  assert.equal(
    harness.store().getMessages(SESSION).filter((message) => message.content === 'uncertain prompt').length,
    1,
    'authoritative history replaces the optimistic uncertain row',
  );
});

test('Given held reconciliation, when every remote mutation control fires, then only subscription recovery reaches the peer channel', async (t) => {
  // Given
  const fetches = stubFetch();
  t.after(fetches.restore);
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    fetches.urls.push(String(input));
    await gate;
    return new Response(JSON.stringify({ data: { messages: [], total: 0 } }), { status: 200 });
  }) as typeof globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const harness = mountChat({ hostId: PEER_A });
  t.after(harness.dispose);
  harness.chat().sendMessage({ type: 'chat.send', sessionId: SESSION, content: 'first' });
  const first = harness.remoteSockets[0];
  assert.ok(first);
  first.open();
  await dropAndSettle(harness, first.drop);

  // When
  harness.chat().sendMessage({ type: 'chat.subscribe', sessions: [{ sessionId: SESSION, lastSeq: 1 }] });
  const recovery = harness.remoteSockets[1];
  assert.ok(recovery);
  recovery.open();
  const mutations = [
    { type: 'chat.send', sessionId: SESSION, content: 'first' },
    { type: 'chat.abort', sessionId: SESSION },
    { type: 'chat.permission-response', requestId: 'permission-1', allow: true },
    { type: 'chat.prompt-response', promptId: 'prompt-1', response: 'choices', choices: [1] },
    { type: 'chat.approval-response', decision: 'approve-once' },
  ];
  for (const mutation of mutations) harness.chat().sendMessage(mutation);

  // Then
  assert.equal(harness.chat().uncertainty?.status, 'reconciling', 'automatic replay subscription cannot dismiss uncertainty');
  assert.equal(harness.chat().blocked, 'reconcile-required');
  assert.equal(harness.remoteSockets.length, 2, 'blocked controls open no additional channel');
  assert.deepEqual(first.frames().filter((frame) => frame.type === 'chat.send').length, 1);
  assert.deepEqual(recovery.frames().map((frame) => frame.type), ['chat.subscribe']);
  release?.();
  await harness.settle();
});

test('Given a reconciled uncertain send with no evidence, when the user resends, then the send is dispatched exactly once', async (t) => {
  // Given
  const fetches = stubFetch();
  t.after(fetches.restore);
  fetches.reply({ messages: [], total: 0 });
  const harness = mountChat({ hostId: PEER_A });
  t.after(harness.dispose);
  harness.chat().sendMessage({ type: 'chat.send', sessionId: SESSION, content: 'lost prompt' });
  const first = harness.remoteSockets[0];
  assert.ok(first);
  first.open();
  await dropAndSettle(harness, first.drop);
  assert.deepEqual(harness.chat().uncertainty?.evidence, 'not-applied');

  // When
  harness.chat().sendMessage({ type: 'chat.send', sessionId: SESSION, content: 'lost prompt' });
  const second = harness.remoteSockets[1];
  assert.ok(second);
  second.open();

  // Then
  assert.deepEqual(second.frames(), [{ type: 'chat.send', hostId: PEER_A, sessionId: SESSION, content: 'lost prompt' }]);
  assert.equal(harness.chat().uncertainty, null);
});

test('Given an unavailable host, when a send is attempted, then it is blocked and no socket is opened', (t) => {
  // Given
  const fetches = stubFetch();
  t.after(fetches.restore);
  const harness = mountChat({ hostId: PEER_A, availability: 'unavailable' });
  t.after(harness.dispose);

  // When
  harness.chat().sendMessage({ type: 'chat.send', sessionId: SESSION, content: 'to nowhere' });

  // Then
  assert.equal(harness.chat().blocked, 'host-unavailable');
  assert.equal(harness.remoteSockets.length, 0);
  assert.deepEqual(harness.localFrames, []);
});
