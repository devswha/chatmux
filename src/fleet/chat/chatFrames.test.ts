import assert from 'node:assert/strict';
import test from 'node:test';

import { type HostChatContext, routeChatFrame } from './chatFrames';

const LOCAL = '11111111-1111-4111-8111-111111111111';
const PEER_A = '22222222-2222-4222-8222-222222222222';
const SESSION = 'session-collision';

const localContext: HostChatContext = {
  hostId: LOCAL, localHostId: LOCAL, sessionId: SESSION, availability: 'ready', reconcileRequired: false,
};
const remoteContext: HostChatContext = {
  hostId: PEER_A, localHostId: LOCAL, sessionId: SESSION, availability: 'ready', reconcileRequired: false,
};

test('Given the local host, when any chat frame is routed, then it stays on the existing local socket untouched', () => {
  // Given / When
  const send = routeChatFrame({ type: 'chat.send', sessionId: SESSION, content: 'hi', options: { model: 'x' } }, localContext);
  const subscribe = routeChatFrame({ type: 'chat.subscribe', sessions: [{ sessionId: SESSION, lastSeq: 4 }] }, localContext);

  // Then
  assert.deepEqual(send, { kind: 'local' });
  assert.deepEqual(subscribe, { kind: 'local' });
});

test('Given a remote session, when chat frames are routed, then each is host-qualified for exactly that host and session', () => {
  // Given / When
  const send = routeChatFrame({ type: 'chat.send', sessionId: SESSION, content: 'hi', options: { model: 'x' } }, remoteContext);
  const abort = routeChatFrame({ type: 'chat.abort', sessionId: SESSION }, remoteContext);
  const subscribe = routeChatFrame({ type: 'chat.subscribe', sessions: [{ sessionId: SESSION, lastSeq: 9 }, { sessionId: 'other', lastSeq: 0 }] }, remoteContext);
  const permission = routeChatFrame({ type: 'chat.permission-response', requestId: 'req-1', allow: true }, remoteContext);

  // Then
  assert.deepEqual(send, { kind: 'remote', frames: [{ type: 'chat.send', hostId: PEER_A, sessionId: SESSION, content: 'hi' }] });
  assert.deepEqual(abort, { kind: 'remote', frames: [{ type: 'chat.abort', hostId: PEER_A, sessionId: SESSION }] });
  assert.deepEqual(subscribe, {
    kind: 'remote',
    frames: [{ type: 'chat.subscribe', hostId: PEER_A, sessionId: SESSION, lastSeq: 9 }],
  });
  assert.deepEqual(permission, { kind: 'remote', frames: [{ type: 'chat.permission-response', hostId: PEER_A, sessionId: SESSION, allow: true }] });
});

test('Given a frame naming another session, when it is routed for a remote host, then it is blocked instead of retargeted', () => {
  // Given / When
  const mismatch = routeChatFrame({ type: 'chat.send', sessionId: 'not-open', content: 'hi' }, remoteContext);

  // Then
  assert.deepEqual(mismatch, { kind: 'blocked', reason: 'session-mismatch' });
});

test('Given an unavailable or synchronizing host, when a chat frame is routed, then the frame is blocked with the host reason', () => {
  // Given / When
  const offline = routeChatFrame({ type: 'chat.send', sessionId: SESSION, content: 'hi' }, { ...remoteContext, availability: 'unavailable' });
  const syncing = routeChatFrame({ type: 'chat.abort', sessionId: SESSION }, { ...remoteContext, availability: 'syncing' });

  // Then
  assert.deepEqual(offline, { kind: 'blocked', reason: 'host-unavailable' });
  assert.deepEqual(syncing, { kind: 'blocked', reason: 'host-syncing' });
});

test('Given an unreconciled uncertain outcome, when remote controls fire, then only read-only subscription recovery is dispatchable', () => {
  // Given
  const pending: HostChatContext = { ...remoteContext, reconcileRequired: true };
  const mutations = [
    { type: 'chat.send', sessionId: SESSION, content: 'again' },
    { type: 'chat.abort', sessionId: SESSION },
    { type: 'chat.permission-response', requestId: 'permission-1', allow: true },
    { type: 'chat.prompt-response', promptId: 'prompt-1', response: 'choices', choices: [1] },
    { type: 'chat.approval-response', decision: 'approve-once' },
  ];

  // When
  const routedMutations = mutations.map((frame) => routeChatFrame(frame, pending));
  const subscribe = routeChatFrame(
    { type: 'chat.subscribe', sessions: [{ sessionId: SESSION, lastSeq: 1 }] },
    pending,
  );

  // Then
  assert.deepEqual(
    routedMutations,
    mutations.map(() => ({ kind: 'blocked', reason: 'reconcile-required' })),
  );
  assert.deepEqual(subscribe, {
    kind: 'remote',
    frames: [{ type: 'chat.subscribe', hostId: PEER_A, sessionId: SESSION, lastSeq: 1 }],
  });
});

test('Given attachments or an unsupported frame, when routed for a remote host, then the request is blocked rather than silently degraded', () => {
  // Given / When
  const withImages = routeChatFrame(
    { type: 'chat.send', sessionId: SESSION, content: 'look', options: { images: [{ path: '/tmp/a.png' }] } },
    remoteContext,
  );
  const unsupported = routeChatFrame({ type: 'chat.unknown', sessionId: SESSION }, remoteContext);

  // Then
  assert.deepEqual(withImages, { kind: 'blocked', reason: 'attachments-unsupported' });
  assert.deepEqual(unsupported, { kind: 'blocked', reason: 'unsupported-frame' });
});

test('Given a hub-level frame, when routed while a remote session is open, then it keeps using the local socket', () => {
  // Given / When
  const fleetSubscribe = routeChatFrame({ type: 'fleet.subscribe', protocolVersion: 'fleet/1' }, remoteContext);
  const paneSubscribe = routeChatFrame({ type: 'pane.subscribe', subscriptionId: 'p1' }, remoteContext);

  // Then
  assert.deepEqual(fleetSubscribe, { kind: 'local' });
  assert.deepEqual(paneSubscribe, { kind: 'local' });
});
