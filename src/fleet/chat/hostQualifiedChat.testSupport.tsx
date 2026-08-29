/**
 * Mounted harness for `useHostQualifiedChat`.
 *
 * The hook is exercised through a real React tree with the real session store and
 * the real websocket context, so the assertions are about which socket a frame
 * reached — never about a mocked router's bookkeeping.
 */

import assert from 'node:assert/strict';

import { createElement, type ReactNode } from 'react';
import TestRenderer, { act } from 'react-test-renderer';

import WebSocketContext, { type ServerEvent } from '../../contexts/WebSocketContext';
import {
  type NormalizedMessage,
  type SessionStore,
  useSessionStore,
} from '../../stores/useSessionStore';

import type { HostChatAvailability } from './chatFrames';
import type { ChatSocketLike } from './remoteChatChannel';
import { useHostQualifiedChat, type HostQualifiedChat } from './useHostQualifiedChat';

export const LOCAL = '11111111-1111-4111-8111-111111111111';
export const PEER_A = '22222222-2222-4222-8222-222222222222';
export const PEER_B = '33333333-3333-4333-8333-333333333333';
export const SESSION = 'session-collision';

export type FakeSocket = ChatSocketLike & {
  readonly frames: () => readonly Readonly<Record<string, unknown>>[];
  readonly open: () => void;
  readonly deliver: (payload: unknown) => void;
  readonly drop: () => void;
};

export function fakeSocket(): FakeSocket {
  const listeners = new Map<string, ((event: { data?: unknown }) => void)[]>();
  const sent: Readonly<Record<string, unknown>>[] = [];
  const emit = (type: string, event: { data?: unknown }): void => {
    for (const listener of listeners.get(type) ?? []) listener(event);
  };
  return {
    frames: () => sent,
    send: (data) => sent.push(JSON.parse(data) as Readonly<Record<string, unknown>>),
    close: () => emit('close', {}),
    addEventListener: (type, listener) => {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    open: () => emit('open', {}),
    deliver: (payload) => emit('message', { data: JSON.stringify(payload) }),
    drop: () => emit('close', {}),
  };
}

export type ChatHarness = {
  readonly chat: () => HostQualifiedChat;
  readonly store: () => SessionStore;
  readonly received: readonly ServerEvent[];
  readonly localFrames: readonly unknown[];
  readonly remoteSockets: readonly FakeSocket[];
  readonly emitLocal: (event: ServerEvent) => void;
  readonly rescope: (hostId: string | null) => void;
  readonly setAvailability: (availability: HostChatAvailability) => void;
  readonly settle: () => Promise<void>;
  /** Rendered tree, for assertions about the production UI under test. */
  readonly tree: () => TestRenderer.ReactTestRenderer;
  readonly dispose: () => void;
};

export type ChatHarnessOptions = {
  readonly hostId: string | null;
  readonly availability?: HostChatAvailability;
  readonly onIdle?: (sessionId: string | null | undefined) => void;
  /** Renders production UI from the live hook state instead of nothing. */
  readonly renderChat?: (chat: HostQualifiedChat) => ReactNode;
};

export function mountChat(options: ChatHarnessOptions): ChatHarness {
  const localFrames: unknown[] = [];
  const remoteSockets: FakeSocket[] = [];
  const received: ServerEvent[] = [];
  const localListeners = new Set<(event: ServerEvent) => void>();
  let latest: HostQualifiedChat | undefined;
  let latestStore: SessionStore | undefined;

  function Surface({
    hostId,
    availability,
  }: {
    hostId: string | null;
    availability: HostChatAvailability;
  }): ReactNode {
    const scope = { hostId, localHostId: LOCAL };
    const sessionStore = useSessionStore(scope);
    latestStore = sessionStore;
    latest = useHostQualifiedChat({
      scope,
      session: { localId: SESSION, availability },
      sessionStore,
      onSessionIdle: options.onIdle,
      connect: () => {
        const socket = fakeSocket();
        remoteSockets.push(socket);
        return socket;
      },
    });
    return options.renderChat?.(latest) ?? null;
  }

  function Tree({
    hostId,
    availability,
  }: {
    hostId: string | null;
    availability: HostChatAvailability;
  }): ReactNode {
    return createElement(
      WebSocketContext.Provider,
      {
        value: {
          ws: null,
          isConnected: true,
          latestMessage: null,
          sendMessage: (message: unknown) => { localFrames.push(message); },
          subscribe: (listener: (event: ServerEvent) => void) => {
            localListeners.add(listener);
            return () => localListeners.delete(listener);
          },
        },
      },
      createElement(Surface, { hostId, availability }),
    );
  }

  let currentHostId = options.hostId;
  let currentAvailability = options.availability ?? 'ready';
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  act(() => {
    renderer = TestRenderer.create(createElement(Tree, {
      hostId: currentHostId,
      availability: currentAvailability,
    }));
  });
  const active = renderer;
  assert.ok(active);
  const chat = (): HostQualifiedChat => {
    assert.ok(latest);
    return latest;
  };
  act(() => { chat().subscribe((event) => { received.push(event); }); });
  return {
    chat,
    store: () => {
      assert.ok(latestStore);
      return latestStore;
    },
    received,
    localFrames,
    remoteSockets,
    emitLocal: (event) => act(() => { for (const listener of localListeners) listener(event); }),
    rescope: (hostId) => act(() => {
      currentHostId = hostId;
      active.update(createElement(Tree, { hostId, availability: currentAvailability }));
    }),
    setAvailability: (availability) => act(() => {
      currentAvailability = availability;
      active.update(createElement(Tree, { hostId: currentHostId, availability }));
    }),
    settle: async () => { await act(async () => { await Promise.resolve(); }); },
    tree: () => active,
    dispose: () => act(() => { active.unmount(); }),
  };
}

export function stubFetch(): {
  readonly urls: string[];
  readonly reply: (body: unknown) => void;
  readonly restore: () => void;
} {
  const original = globalThis.fetch;
  const urls: string[] = [];
  let payload: unknown = { messages: [], total: 0 };
  globalThis.fetch = ((input: RequestInfo | URL) => {
    urls.push(String(input));
    return Promise.resolve(new Response(JSON.stringify({ data: payload }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
  }) as typeof globalThis.fetch;
  return {
    urls,
    reply: (body) => { payload = body; },
    restore: () => { globalThis.fetch = original; },
  };
}

/** Drops a host connection and lets the reconcile read settle. */
export async function dropAndSettle(harness: ChatHarness, drop: () => void): Promise<void> {
  drop();
  await harness.settle();
}

export const serverMessage = (id: string, content: string): NormalizedMessage => ({
  id,
  sessionId: SESSION,
  timestamp: '2026-01-01T00:00:00Z',
  kind: 'text',
  role: 'user',
  provider: 'gjc',
  content,
});
