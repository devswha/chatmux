import assert from 'node:assert/strict';
import test from 'node:test';

import i18next from 'i18next';
import { createElement } from 'react';
import { I18nextProvider } from 'react-i18next';
import type { ReactTestInstance } from 'react-test-renderer';

import enChat from '../../../../i18n/locales/en/chat.json';
import {
  dropAndSettle,
  mountChat,
  PEER_A,
  SESSION,
  serverMessage,
  stubFetch,
  type ChatHarness,
} from '../../../../fleet/chat/hostQualifiedChat.testSupport';

import ChatHostNotice from './ChatHostNotice';

const i18n = i18next.createInstance();
await i18n.init({
  lng: 'en',
  fallbackLng: false,
  resources: { en: { chat: enChat } },
  ns: ['chat'],
  defaultNS: 'chat',
  interpolation: { escapeValue: false },
});

/** Mounts the real hook with the shipped notice rendered from its live state. */
function mountNotice(options: { readonly availability?: 'ready' | 'syncing' | 'unavailable' }): ChatHarness {
  return mountChat({
    hostId: PEER_A,
    availability: options.availability,
    renderChat: (chat) => createElement(
      I18nextProvider,
      { i18n },
      createElement(ChatHostNotice, {
        blocked: chat.blocked,
        uncertainty: chat.uncertainty,
        onAcknowledge: chat.acknowledge,
      }),
    ),
  });
}

function noticeState(harness: ChatHarness): string | null {
  const found = harness.tree().root.findAll(
    (node: ReactTestInstance) => typeof node.type === 'string'
      && typeof node.props['data-chat-host-notice'] === 'string',
  );
  return found.length === 0 ? null : String(found[0]?.props['data-chat-host-notice']);
}

function dismiss(harness: ChatHarness): void {
  const button = harness.tree().root.findAll(
    (node: ReactTestInstance) => typeof node.type === 'string'
      && node.props['data-chat-host-notice-dismiss'] !== undefined,
  );
  assert.equal(button.length, 1, 'a reconciled outcome must be dismissible');
  (button[0]?.props as { onClick: () => void }).onClick();
}

test('Given a ready host, when nothing has failed, then no notice is shown', (t) => {
  // Given
  const harness = mountNotice({});
  t.after(harness.dispose);

  // When / Then
  assert.equal(noticeState(harness), null);
});

test('Given an unavailable host, when a send is attempted, then the notice names the refusal', (t) => {
  // Given
  const harness = mountNotice({ availability: 'unavailable' });
  t.after(harness.dispose);

  // When
  harness.chat().sendMessage({ type: 'chat.send', sessionId: SESSION, content: 'hello' });

  // Then
  assert.equal(noticeState(harness), 'blocked:host-unavailable');
  assert.equal(harness.remoteSockets.length, 0);
});

test('Given a synchronizing host, when a send is attempted, then the notice distinguishes it from unavailable', (t) => {
  // Given
  const harness = mountNotice({ availability: 'syncing' });
  t.after(harness.dispose);

  // When
  harness.chat().sendMessage({ type: 'chat.send', sessionId: SESSION, content: 'hello' });

  // Then
  assert.equal(noticeState(harness), 'blocked:host-syncing');
});

test('Given a committed syncing transition, when the previously mounted submit callback fires immediately, then admission blocks before optimistic state or a browser frame', (t) => {
  // Given: arm the observable frame/notice surfaces before the transition.
  const harness = mountNotice({ availability: 'ready' });
  t.after(harness.dispose);
  const admitFromReadyRender = harness.chat().admitSubmit;
  const socketsAtArm = harness.remoteSockets.length;
  const optimisticAtArm = harness.store().getMessages(SESSION).length;

  // When: commit syncing, then invoke the stable callback retained by the composer.
  harness.setAvailability('syncing');
  const admitted = admitFromReadyRender();
  if (admitted) {
    harness.store().appendRealtime(SESSION, serverMessage('local-syncing', 'while syncing'));
    harness.chat().sendMessage({ type: 'chat.send', sessionId: SESSION, content: 'while syncing' });
  }

  // Then
  assert.equal(admitted, false);
  assert.equal(noticeState(harness), 'blocked:host-syncing');
  assert.equal(harness.remoteSockets.length, socketsAtArm, 'zero outbound browser chat frames');
  assert.equal(
    harness.store().getMessages(SESSION).length,
    optimisticAtArm,
    'admission precedes the optimistic append',
  );
});

test('Given a dispatched send, when the connection drops before acknowledgement, then the notice reports an unknown outcome then the reconciled verdict', async (t) => {
  // Given
  const fetches = stubFetch();
  t.after(fetches.restore);
  const harness = mountNotice({});
  t.after(harness.dispose);
  harness.chat().sendMessage({ type: 'chat.send', sessionId: SESSION, content: 'unacknowledged' });
  const socket = harness.remoteSockets[0];
  assert.ok(socket);
  socket.open();
  fetches.reply({ messages: [], total: 0 });

  // When
  await dropAndSettle(harness, () => socket.drop());

  // Then
  assert.equal(noticeState(harness), 'uncertain:reconciled:not-applied');
  dismiss(harness);
  assert.equal(noticeState(harness), null);
});

test('Given a dispatched send the host did apply, when the reconcile reads it back, then the notice says so and never suggests resending', async (t) => {
  // Given
  const fetches = stubFetch();
  t.after(fetches.restore);
  const harness = mountNotice({});
  t.after(harness.dispose);
  harness.chat().sendMessage({ type: 'chat.send', sessionId: SESSION, content: 'landed' });
  const socket = harness.remoteSockets[0];
  assert.ok(socket);
  socket.open();
  fetches.reply({ messages: [serverMessage('m-1', 'landed')], total: 1 });

  // When
  await dropAndSettle(harness, () => socket.drop());

  // Then
  assert.equal(noticeState(harness), 'uncertain:reconciled:applied');
  assert.equal(socket.frames().length, 1, 'the dispatched frame must never be resent');
});

test('Given an unreconciled uncertain send, when the user sends again, then the unresolved outcome stays on screen and nothing is dispatched', (t) => {
  // Given
  const harness = mountNotice({});
  t.after(harness.dispose);
  harness.chat().sendMessage({ type: 'chat.send', sessionId: SESSION, content: 'first' });
  const socket = harness.remoteSockets[0];
  assert.ok(socket);
  socket.open();
  socket.drop();

  // When
  harness.chat().sendMessage({ type: 'chat.send', sessionId: SESSION, content: 'second' });

  // Then
  // The unresolved outcome is the reason the resend was refused, so it stays
  // rather than being replaced by a second, less informative refusal.
  assert.equal(noticeState(harness), 'uncertain:reconciling');
  assert.equal(socket.frames().length, 1);
});
