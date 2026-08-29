import assert from 'node:assert/strict';
import test from 'node:test';

import { createRemoteChatChannel, type ChatSocketLike, type RemoteChatEvent } from './remoteChatChannel';

const PEER_A = '22222222-2222-4222-8222-222222222222';
const SESSION = 'session-collision';

type FakeSocket = ChatSocketLike & {
  readonly sent: readonly string[];
  readonly closed: () => boolean;
  open: () => void;
  deliver: (payload: unknown) => void;
  drop: () => void;
};

function fakeSocket(): FakeSocket {
  const listeners = new Map<string, ((event: { data?: unknown }) => void)[]>();
  const sent: string[] = [];
  let closed = false;
  const emit = (type: string, event: { data?: unknown }): void => {
    for (const listener of listeners.get(type) ?? []) listener(event);
  };
  return {
    sent,
    closed: () => closed,
    send: (data) => sent.push(data),
    close: () => { closed = true; emit('close', {}); },
    addEventListener: (type, listener) => {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    open: () => emit('open', {}),
    deliver: (payload) => emit('message', { data: JSON.stringify(payload) }),
    drop: () => { closed = true; emit('close', {}); },
  };
}

function harness() {
  const sockets: FakeSocket[] = [];
  const events: RemoteChatEvent[] = [];
  const channel = createRemoteChatChannel({
    hostId: PEER_A,
    connect: () => { const socket = fakeSocket(); sockets.push(socket); return socket; },
    onEvent: (event) => events.push(event),
  });
  return { channel, sockets, events };
}

test('Given frames sent before the socket opens, when it opens, then every queued frame is delivered once in order', () => {
  // Given
  const { channel, sockets } = harness();

  // When
  channel.send([{ type: 'chat.subscribe', hostId: PEER_A, sessionId: SESSION }]);
  channel.send([{ type: 'chat.send', hostId: PEER_A, sessionId: SESSION, content: 'hi' }]);
  const socket = sockets[0];
  assert.ok(socket);
  assert.deepEqual(socket.sent, []);
  socket.open();

  // Then
  assert.deepEqual(socket.sent.map((payload) => JSON.parse(payload).type), ['chat.subscribe', 'chat.send']);
  assert.equal(sockets.length, 1);
  channel.close();
});

test('Given an open channel, when the host answers, then each frame reaches the listener tagged with its host', () => {
  // Given
  const { channel, sockets, events } = harness();
  channel.send([{ type: 'chat.send', hostId: PEER_A, sessionId: SESSION, content: 'hi' }]);
  const socket = sockets[0];
  assert.ok(socket);
  socket.open();

  // When
  socket.deliver({ kind: 'chat_accepted', hostId: PEER_A, sessionId: SESSION });
  socket.deliver({ kind: 'protocol_error', code: 'HOST_OFFLINE', error: 'Fleet host is offline.', sessionId: null });
  socket.deliver('not-json');

  // Then
  assert.deepEqual(events, [
    { kind: 'frame', hostId: PEER_A, frame: { kind: 'chat_accepted', hostId: PEER_A, sessionId: SESSION } },
    { kind: 'frame', hostId: PEER_A, frame: { kind: 'protocol_error', code: 'HOST_OFFLINE', error: 'Fleet host is offline.', sessionId: null } },
  ]);
  channel.close();
});

test('Given a dispatched send, when the connection drops before its acknowledgement, then the outcome is reported unknown and nothing is resent', () => {
  // Given
  const { channel, sockets, events } = harness();
  channel.send([{ type: 'chat.send', hostId: PEER_A, sessionId: SESSION, content: 'hi' }]);
  const first = sockets[0];
  assert.ok(first);
  first.open();

  // When
  first.drop();
  channel.send([{ type: 'chat.subscribe', hostId: PEER_A, sessionId: SESSION }]);
  const second = sockets[1];
  assert.ok(second);
  second.open();

  // Then
  assert.deepEqual(events, [
    { kind: 'uncertain', hostId: PEER_A, sessionId: SESSION, operation: 'chat.send' },
    { kind: 'frame', hostId: PEER_A, frame: { kind: 'websocket_reconnected' } },
  ]);
  assert.deepEqual(second.sent.map((payload) => JSON.parse(payload).type), ['chat.subscribe']);
  channel.close();
});

test('Given an acknowledged send, when the connection later drops, then replay reconciliation is requested without uncertainty', () => {
  // Given
  const { channel, sockets, events } = harness();
  channel.send([{ type: 'chat.send', hostId: PEER_A, sessionId: SESSION, content: 'hi' }]);
  const socket = sockets[0];
  assert.ok(socket);
  socket.open();

  // When
  socket.deliver({ kind: 'chat_accepted', hostId: PEER_A, sessionId: SESSION });
  socket.drop();

  // Then
  assert.deepEqual(events, [
    {
      kind: 'frame',
      hostId: PEER_A,
      frame: { kind: 'chat_accepted', hostId: PEER_A, sessionId: SESSION },
    },
    {
      kind: 'frame',
      hostId: PEER_A,
      frame: { kind: 'websocket_reconnected' },
    },
  ]);
  channel.close();
});

test('Given a closed channel, when the socket later reports a frame, then nothing is emitted and the socket is closed', () => {
  // Given
  const { channel, sockets, events } = harness();
  channel.send([{ type: 'chat.subscribe', hostId: PEER_A, sessionId: SESSION }]);
  const socket = sockets[0];
  assert.ok(socket);
  socket.open();

  // When
  channel.close();
  socket.deliver({ kind: 'chat_accepted', hostId: PEER_A, sessionId: SESSION });

  // Then
  assert.equal(socket.closed(), true);
  assert.deepEqual(events.filter((event) => event.kind === 'frame'), []);
});
