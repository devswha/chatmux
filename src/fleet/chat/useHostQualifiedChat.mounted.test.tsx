import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LOCAL,
  mountChat,
  PEER_A,
  PEER_B,
  SESSION,
  stubFetch,
} from './hostQualifiedChat.testSupport';

test('Given a local session, when chat frames are sent, then the existing app socket carries them and no remote socket opens', (t) => {
  // Given
  const fetches = stubFetch();
  t.after(fetches.restore);
  const harness = mountChat({ hostId: LOCAL });
  t.after(harness.dispose);

  // When
  harness.chat().sendMessage({ type: 'chat.send', sessionId: SESSION, content: 'local hello', options: { model: 'x' } });
  harness.chat().sendMessage({ type: 'chat.subscribe', sessions: [{ sessionId: SESSION, lastSeq: 3 }] });

  // Then
  assert.deepEqual(harness.localFrames, [
    { type: 'chat.send', sessionId: SESSION, content: 'local hello', options: { model: 'x' } },
    { type: 'chat.subscribe', sessions: [{ sessionId: SESSION, lastSeq: 3 }] },
  ]);
  assert.equal(harness.remoteSockets.length, 0);
  assert.equal(harness.chat().uncertainty, null);
});

test('Given a session on peer A, when chat frames are sent, then only the host-qualified channel carries them', (t) => {
  // Given
  const fetches = stubFetch();
  t.after(fetches.restore);
  const harness = mountChat({ hostId: PEER_A });
  t.after(harness.dispose);

  // When
  harness.chat().sendMessage({ type: 'chat.subscribe', sessions: [{ sessionId: SESSION, lastSeq: 7 }] });
  harness.chat().sendMessage({ type: 'chat.send', sessionId: SESSION, content: 'peer hello', options: { model: 'x' } });
  const socket = harness.remoteSockets[0];
  assert.ok(socket);
  socket.open();

  // Then
  assert.deepEqual(socket.frames(), [
    { type: 'chat.subscribe', hostId: PEER_A, sessionId: SESSION, lastSeq: 7 },
    { type: 'chat.send', hostId: PEER_A, sessionId: SESSION, content: 'peer hello' },
  ]);
  assert.deepEqual(harness.localFrames, []);
});

test('Given the same session id on two peers, when the open host switches, then the next send reaches only the new host', (t) => {
  // Given
  const fetches = stubFetch();
  t.after(fetches.restore);
  const harness = mountChat({ hostId: PEER_A });
  t.after(harness.dispose);
  harness.chat().sendMessage({ type: 'chat.send', sessionId: SESSION, content: 'for A' });
  const socketA = harness.remoteSockets[0];
  assert.ok(socketA);
  socketA.open();
  socketA.deliver({ kind: 'chat_accepted', hostId: PEER_A, sessionId: SESSION });

  // When
  harness.rescope(PEER_B);
  harness.chat().sendMessage({ type: 'chat.send', sessionId: SESSION, content: 'for B' });
  const socketB = harness.remoteSockets[1];
  assert.ok(socketB);
  socketB.open();

  // Then
  assert.deepEqual(socketA.frames().map((frame) => frame.content), ['for A']);
  assert.deepEqual(socketB.frames(), [{ type: 'chat.send', hostId: PEER_B, sessionId: SESSION, content: 'for B' }]);
  assert.notEqual(socketA, socketB);
});

test('Given an abort on peer A, when the host acknowledges it, then the subscriber sees exactly one terminal aborted completion', (t) => {
  // Given
  const idled: string[] = [];
  const fetches = stubFetch();
  t.after(fetches.restore);
  const harness = mountChat({ hostId: PEER_A, onIdle: (sessionId) => idled.push(String(sessionId)) });
  t.after(harness.dispose);
  harness.chat().sendMessage({ type: 'chat.abort', sessionId: SESSION });
  const socket = harness.remoteSockets[0];
  assert.ok(socket);
  socket.open();

  // When
  socket.deliver({ kind: 'chat_accepted', hostId: PEER_A, sessionId: SESSION });
  socket.deliver({ kind: 'chat_aborted', hostId: PEER_A, sessionId: SESSION });

  // Then
  assert.deepEqual(harness.received, [{ kind: 'complete', sessionId: SESSION, aborted: true }]);
  assert.deepEqual(socket.frames(), [{ type: 'chat.abort', hostId: PEER_A, sessionId: SESSION }]);
  assert.deepEqual(idled, []);
});

test('Given a remote session, when the hub reports replayed stream data, a protocol error, or a subscribe acknowledgement, then each reaches the subscriber', (t) => {
  // Given
  const fetches = stubFetch();
  t.after(fetches.restore);
  const harness = mountChat({ hostId: PEER_A });
  t.after(harness.dispose);
  harness.chat().sendMessage({ type: 'chat.subscribe', sessions: [{ sessionId: SESSION, lastSeq: 0 }] });
  const socket = harness.remoteSockets[0];
  assert.ok(socket);
  socket.open();

  // When
  socket.deliver({ kind: 'chat_subscribed', hostId: PEER_A, sessionId: SESSION, isProcessing: true, lastSeq: 2 });
  socket.deliver({
    kind: 'stream_delta', id: 'delta-2', sessionId: SESSION, provider: 'gjc',
    timestamp: '2026-01-01T00:00:00Z', content: 'peer stream', seq: 2,
  });
  socket.deliver({ kind: 'protocol_error', code: 'HOST_SYNCING', error: 'Fleet host is synchronizing.', sessionId: null });

  // Then
  assert.deepEqual(harness.received, [
    { kind: 'chat_subscribed', hostId: PEER_A, sessionId: SESSION, isProcessing: true, lastSeq: 2 },
    {
      kind: 'stream_delta', id: 'delta-2', sessionId: SESSION, provider: 'gjc',
      timestamp: '2026-01-01T00:00:00Z', content: 'peer stream', seq: 2,
    },
    { kind: 'protocol_error', code: 'HOST_SYNCING', error: 'Fleet host is synchronizing.', sessionId: SESSION },
  ]);
});

test('Given a remote session, when the local app socket reconnects, then the reconnect reaches the subscriber and other local frames do not', (t) => {
  // Given
  const fetches = stubFetch();
  t.after(fetches.restore);
  const harness = mountChat({ hostId: PEER_A });
  t.after(harness.dispose);

  // When
  harness.emitLocal({ kind: 'websocket_reconnected', timestamp: 1 });
  harness.emitLocal({ kind: 'stream_delta', sessionId: SESSION, content: 'hub text' });

  // Then
  assert.deepEqual(harness.received, [{ kind: 'websocket_reconnected', timestamp: 1 }]);
});

test('Given a local session, when local frames arrive, then the subscriber receives them unchanged', (t) => {
  // Given
  const fetches = stubFetch();
  t.after(fetches.restore);
  const harness = mountChat({ hostId: LOCAL });
  t.after(harness.dispose);

  // When
  harness.emitLocal({ kind: 'stream_delta', sessionId: SESSION, content: 'local text' });

  // Then
  assert.deepEqual(harness.received, [{ kind: 'stream_delta', sessionId: SESSION, content: 'local text' }]);
});
