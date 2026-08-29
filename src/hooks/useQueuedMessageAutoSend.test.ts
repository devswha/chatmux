import assert from 'node:assert/strict';
import test from 'node:test';

import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';

import { readQueuedDraft, writeQueuedDraft, type PersistedStateStorage } from '../fleet/persistedHostState';
import { sessionRef, sessionSlotKey } from '../fleet/references';

import type { QualifiedSessionActivityMap, SessionActivity } from './useSessionProtection';
import { useQueuedMessageAutoSend } from './useQueuedMessageAutoSend';

const HOST_A = '11111111-1111-4111-8111-111111111111';
const HOST_B = '22222222-2222-4222-8222-222222222222';

function fakeStorage(): PersistedStateStorage & { entries: Map<string, string> } {
  const entries = new Map<string, string>();
  return {
    entries,
    keys: () => [...entries.keys()],
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => { entries.set(key, value); },
    removeItem: (key) => { entries.delete(key); },
  };
}

function activity(hostId: string | null, localId: string): SessionActivity {
  return { statusText: null, canInterrupt: true, startedAt: 1, hostId, localId };
}

function processing(...entries: readonly SessionActivity[]): QualifiedSessionActivityMap {
  return new Map(entries.map((entry) => [sessionSlotKey(entry.hostId, entry.localId), entry]));
}

type Harness = {
  render: (processingSessions: QualifiedSessionActivityMap) => void;
  sent: unknown[];
  marked: { hostId: string | null; localId: string }[];
  unmount: () => void;
};

function mountAutoSend(options: {
  storage: PersistedStateStorage;
  localHostId: string | null;
  activeSessionKey?: string | null;
  liveSessionKeys?: ReadonlySet<string>;
  socketOpen?: boolean;
}): Harness {
  const sent: unknown[] = [];
  const marked: { hostId: string | null; localId: string }[] = [];
  const ws = { readyState: options.socketOpen === false ? WebSocket.CLOSED : WebSocket.OPEN } as WebSocket;

  function Harness({ processingSessions }: { processingSessions: QualifiedSessionActivityMap }) {
    useQueuedMessageAutoSend({
      processingSessions,
      activeSessionKey: options.activeSessionKey ?? null,
      liveSessionKeys: options.liveSessionKeys,
      localHostId: options.localHostId,
      storage: options.storage,
      ws,
      sendMessage: (message) => sent.push(message),
      markProcessing: (target) => {
        if (target) marked.push(target);
      },
    });
    return null;
  }

  let renderer: TestRenderer.ReactTestRenderer | undefined;
  return {
    sent,
    marked,
    render: (processingSessions) => {
      act(() => {
        if (renderer) {
          renderer.update(createElement(Harness, { processingSessions }));
          return;
        }
        renderer = TestRenderer.create(createElement(Harness, { processingSessions }));
      });
    },
    unmount: () => act(() => renderer?.unmount()),
  };
}

test('Given queued drafts for one local id on two hosts, when the local run finishes, then only the local draft is sent', (t) => {
  // Given
  const storage = fakeStorage();
  writeQueuedDraft(storage, sessionRef(HOST_A, 'session-42'), { content: 'draft for a', options: { model: 'opus' } });
  writeQueuedDraft(storage, sessionRef(HOST_B, 'session-42'), { content: 'draft for b' });
  const harness = mountAutoSend({ storage, localHostId: HOST_A });
  t.after(harness.unmount);
  harness.render(processing(activity(HOST_A, 'session-42'), activity(HOST_B, 'session-42')));

  // When
  harness.render(processing(activity(HOST_B, 'session-42')));

  // Then
  assert.deepEqual(harness.sent, [{
    type: 'chat.send',
    sessionId: 'session-42',
    content: 'draft for a',
    options: { model: 'opus', images: [] },
  }]);
  assert.equal(readQueuedDraft(storage, sessionRef(HOST_A, 'session-42')), null, 'the sent draft is claimed');
  assert.deepEqual(readQueuedDraft(storage, sessionRef(HOST_B, 'session-42')), { content: 'draft for b' });
  assert.deepEqual(harness.marked, [{ hostId: HOST_A, localId: 'session-42' }]);
});

test('Given a remote session draft, when its run finishes, then the draft is kept instead of sent to the local host', (t) => {
  // Given
  const storage = fakeStorage();
  writeQueuedDraft(storage, sessionRef(HOST_B, 'session-42'), { content: 'draft for b' });
  const harness = mountAutoSend({ storage, localHostId: HOST_A });
  t.after(harness.unmount);
  harness.render(processing(activity(HOST_B, 'session-42')));

  // When
  harness.render(processing());

  // Then
  assert.deepEqual(harness.sent, [], 'a remote draft must never be dispatched through the local session route');
  assert.deepEqual(readQueuedDraft(storage, sessionRef(HOST_B, 'session-42')), { content: 'draft for b' });
});

test('Given the viewed session, when its run finishes, then the composer keeps ownership of its draft', (t) => {
  // Given
  const storage = fakeStorage();
  writeQueuedDraft(storage, sessionRef(HOST_A, 'session-42'), { content: 'viewed draft' });
  const harness = mountAutoSend({
    storage,
    localHostId: HOST_A,
    activeSessionKey: sessionSlotKey(HOST_A, 'session-42'),
  });
  t.after(harness.unmount);
  harness.render(processing(activity(HOST_A, 'session-42')));

  // When
  harness.render(processing());

  // Then
  assert.deepEqual(harness.sent, []);
  assert.deepEqual(readQueuedDraft(storage, sessionRef(HOST_A, 'session-42')), { content: 'viewed draft' });
});

test('Given an externally driven session on the local host, when its run finishes, then nothing is injected', (t) => {
  // Given
  const storage = fakeStorage();
  writeQueuedDraft(storage, sessionRef(HOST_A, 'session-42'), { content: 'tmux owned' });
  const harness = mountAutoSend({
    storage,
    localHostId: HOST_A,
    liveSessionKeys: new Set([sessionSlotKey(HOST_A, 'session-42')]),
  });
  t.after(harness.unmount);
  harness.render(processing(activity(HOST_A, 'session-42')));

  // When
  harness.render(processing());

  // Then
  assert.deepEqual(harness.sent, []);
  assert.deepEqual(readQueuedDraft(storage, sessionRef(HOST_A, 'session-42')), { content: 'tmux owned' });
});

test('Given a closed socket, when a run finishes, then the draft is kept for a later retry', (t) => {
  // Given
  const storage = fakeStorage();
  writeQueuedDraft(storage, sessionRef(HOST_A, 'session-42'), { content: 'retry me' });
  const harness = mountAutoSend({ storage, localHostId: HOST_A, socketOpen: false });
  t.after(harness.unmount);
  harness.render(processing(activity(HOST_A, 'session-42')));

  // When
  harness.render(processing());

  // Then
  assert.deepEqual(harness.sent, []);
  assert.deepEqual(readQueuedDraft(storage, sessionRef(HOST_A, 'session-42')), { content: 'retry me' });
});

test('Given a pre-identity legacy run, when it finishes, then its bare-key draft is still sent', (t) => {
  // Given
  const storage = fakeStorage();
  storage.setItem('queued_message_legacy-session', JSON.stringify({ content: 'legacy draft' }));
  const harness = mountAutoSend({ storage, localHostId: null });
  t.after(harness.unmount);
  harness.render(processing(activity(null, 'legacy-session')));

  // When
  harness.render(processing());

  // Then
  assert.deepEqual(harness.sent, [{
    type: 'chat.send',
    sessionId: 'legacy-session',
    content: 'legacy draft',
    options: { images: [] },
  }]);
  assert.equal(storage.getItem('queued_message_legacy-session'), null);
});
