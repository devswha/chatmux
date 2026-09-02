import assert from 'node:assert/strict';
import test from 'node:test';

import { createElement } from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';

import type { NormalizedMessage, SessionStore } from '../../../stores/useSessionStore';

import {
  shouldApplySessionRefresh,
  shouldRefreshCachedImageWindow,
  shouldReplaceSessionMessageWindow,
  useChatSessionState,
} from './useChatSessionState';

type SessionState = ReturnType<typeof useChatSessionState>;

type FakeScrollContainer = HTMLDivElement & {
  clientHeight: number;
  scrollHeight: number;
  scrollTop: number;
};

function fakeSessionStore(withMessage = false) {
  let messages: NormalizedMessage[] = withMessage ? [{
    id: 'message-1',
    sessionId: 'session-1',
    timestamp: new Date().toISOString(),
    provider: 'claude' as const,
    kind: 'text' as const,
    role: 'user' as const,
    content: 'keep this viewport under user control',
  }] : [];
  let pendingExternalContent: string | null = null;
  const store = {
    setActiveSession() {},
    getMessages: () => messages,
    has: () => withMessage,
    fetchFromServer: async () => ({ hasMore: false, total: messages.length }),
    refreshFromServer: async () => {
      if (pendingExternalContent !== null) {
        messages = [...messages, {
          id: `message-${messages.length + 1}`,
          sessionId: 'session-1',
          timestamp: new Date().toISOString(),
          provider: 'claude' as const,
          kind: 'text' as const,
          role: 'assistant' as const,
          content: pendingExternalContent,
        }];
        pendingExternalContent = null;
      }
      return { hasMore: false, total: messages.length, serverMessages: messages };
    },
  } as unknown as SessionStore;

  return {
    store,
    queueExternalMessage: (content: string) => {
      pendingExternalContent = content;
    },
  };
}

function fakeScrollContainer(): FakeScrollContainer {
  const listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  return {
    clientHeight: 300,
    scrollHeight: 900,
    scrollTop: 600,
    firstElementChild: {} as Element,
    addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
      const registered = listeners.get(type) ?? new Set<EventListenerOrEventListenerObject>();
      registered.add(listener);
      listeners.set(type, registered);
    },
    removeEventListener(type: string, listener: EventListenerOrEventListenerObject) {
      listeners.get(type)?.delete(listener);
    },
  } as unknown as FakeScrollContainer;
}

function installScrollBrowserHarness() {
  const originalRequestAnimationFrame = Object.getOwnPropertyDescriptor(globalThis, 'requestAnimationFrame');
  const originalCancelAnimationFrame = Object.getOwnPropertyDescriptor(globalThis, 'cancelAnimationFrame');
  const originalResizeObserver = Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver');
  const originalFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 1;
  let resizeCallback: ResizeObserverCallback | null = null;

  class TestResizeObserver implements ResizeObserver {
    constructor(callback: ResizeObserverCallback) {
      resizeCallback = callback;
    }

    observe() {}
    unobserve() {}
    disconnect() {}
  }

  Object.defineProperty(globalThis, 'requestAnimationFrame', {
    configurable: true,
    value: (callback: FrameRequestCallback) => {
      const id = nextFrame++;
      frames.set(id, callback);
      return id;
    },
  });
  Object.defineProperty(globalThis, 'cancelAnimationFrame', {
    configurable: true,
    value: (id: number) => frames.delete(id),
  });
  Object.defineProperty(globalThis, 'ResizeObserver', {
    configurable: true,
    value: TestResizeObserver,
  });
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    value: async () => ({
      ok: false,
      headers: { get: () => null },
      json: async () => ({}),
    }) as unknown as Response,
  });

  const runNextFrame = () => {
    const next = frames.entries().next().value as [number, FrameRequestCallback] | undefined;
    if (!next) return false;
    frames.delete(next[0]);
    next[1](0);
    return true;
  };

  return {
    pendingFrames: () => frames.size,
    runNextFrame,
    runAllFrames: () => {
      let count = 0;
      while (runNextFrame()) {
        count++;
        assert.ok(count < 100, 'animation-frame loop did not settle');
      }
    },
    triggerResize: () => {
      const callback = resizeCallback;
      assert.ok(callback, 'ResizeObserver was not attached');
      callback([], {} as ResizeObserver);
    },
    restore: () => {
      if (originalRequestAnimationFrame) {
        Object.defineProperty(globalThis, 'requestAnimationFrame', originalRequestAnimationFrame);
      } else {
        Reflect.deleteProperty(globalThis, 'requestAnimationFrame');
      }
      if (originalCancelAnimationFrame) {
        Object.defineProperty(globalThis, 'cancelAnimationFrame', originalCancelAnimationFrame);
      } else {
        Reflect.deleteProperty(globalThis, 'cancelAnimationFrame');
      }
      if (originalResizeObserver) {
        Object.defineProperty(globalThis, 'ResizeObserver', originalResizeObserver);
      } else {
        Reflect.deleteProperty(globalThis, 'ResizeObserver');
      }
      if (originalFetch) {
        Object.defineProperty(globalThis, 'fetch', originalFetch);
      } else {
        Reflect.deleteProperty(globalThis, 'fetch');
      }
    },
  };
}

async function mountScrollHarness({ withMessage = false } = {}) {
  const browser = installScrollBrowserHarness();
  const container = fakeScrollContainer();
  const sessionStoreHarness = fakeSessionStore(withMessage);
  const sessionStore = sessionStoreHarness.store;
  let latest: SessionState | null = null;
  let renderer: ReactTestRenderer | null = null;

  function Probe() {
    latest = useChatSessionState({
      selectedProject: withMessage ? {
        projectId: 'project-1',
        displayName: 'Project 1',
        fullPath: '/tmp/project-1',
      } : null,
      selectedSession: withMessage ? { id: 'session-1' } : null,
      ws: null,
      sendMessage: () => undefined,
      resetStreamingState: () => undefined,
      statusCheckSentAtRef: { current: new Map() },
      lastSeqRef: { current: new Map() },
      sessionStore,
    });
    return createElement('div', { ref: latest.scrollContainerRef });
  }

  try {
    await act(async () => {
      renderer = TestRenderer.create(createElement(Probe), {
        createNodeMock: () => container,
      });
    });
  } catch (error) {
    browser.restore();
    throw error;
  }

  return {
    browser,
    container,
    latest: () => {
      assert.ok(latest);
      return latest;
    },
    pollExternalMessage: async (content: string) => {
      sessionStoreHarness.queueExternalMessage(content);
      await act(async () => {
        await sessionStore.refreshFromServer('session-1');
        renderer?.update(createElement(Probe));
      });
    },
    dispose: async () => {
      if (renderer) await act(async () => renderer?.unmount());
      browser.restore();
    },
  };
}

test('same selected conversation preserves its expanded message window', () => {
  assert.equal(
    shouldReplaceSessionMessageWindow('session-1:project-1', 'session-1:project-1', true),
    false,
  );
});

test('conversation changes and missing cache restore the initial message window', () => {
  assert.equal(
    shouldReplaceSessionMessageWindow('session-1:project-1', 'session-2:project-1', true),
    true,
  );
  assert.equal(
    shouldReplaceSessionMessageWindow('session-1:project-1', 'session-1:project-1', false),
    true,
  );
});

test('re-enabling previews refreshes only an already-cached current conversation', () => {
  assert.equal(
    shouldRefreshCachedImageWindow('session-1:project-1', false, 'session-1:project-1', true, true),
    true,
  );
  assert.equal(
    shouldRefreshCachedImageWindow('session-1:project-1', true, 'session-1:project-1', true, true),
    false,
  );
  assert.equal(
    shouldRefreshCachedImageWindow('session-1:project-1', false, 'session-2:project-1', true, true),
    false,
  );
  assert.equal(
    shouldRefreshCachedImageWindow('session-1:project-1', false, 'session-1:project-1', true, false),
    false,
  );
});

test('cached image refresh cannot update a different selected conversation', () => {
  assert.equal(shouldApplySessionRefresh('session-1', 'session-1'), true);
  assert.equal(shouldApplySessionRefresh('session-1', 'session-2'), false);
  assert.equal(shouldApplySessionRefresh('session-1', null), false);
});

test('scrollToBottom follows layout growth across the next two painted frames', async () => {
  const harness = await mountScrollHarness();
  try {
    harness.container.scrollHeight = 900;
    harness.container.scrollTop = 100;

    act(() => harness.latest().scrollToBottom());
    assert.equal(harness.container.scrollTop, 900, 'scrolls immediately');
    assert.equal(harness.browser.pendingFrames(), 1);

    harness.container.scrollHeight = 1_100;
    act(() => { harness.browser.runNextFrame(); });
    assert.equal(harness.container.scrollTop, 1_100, 'follows the first painted layout');
    assert.equal(harness.browser.pendingFrames(), 1);

    harness.container.scrollHeight = 1_300;
    act(() => { harness.browser.runNextFrame(); });
    assert.equal(harness.container.scrollTop, 1_300, 'follows the second painted layout');
    assert.equal(harness.browser.pendingFrames(), 0);
  } finally {
    await harness.dispose();
  }
});

test('manual scrolling cancels every pending follow-tail correction', async () => {
  const harness = await mountScrollHarness({ withMessage: true });
  try {
    assert.equal(
      harness.browser.pendingFrames(),
      2,
      'initial settling and short post-render correction are both active',
    );

    harness.container.scrollTop = 100;
    await act(async () => { await harness.latest().handleScroll(); });

    assert.equal(harness.latest().isUserScrolledUp, true);
    assert.equal(harness.browser.pendingFrames(), 0, 'all forced-scroll frames are cancelled');
    harness.container.scrollHeight = 1_400;
    harness.browser.runAllFrames();
    assert.equal(harness.container.scrollTop, 100, 'the user-selected position is preserved');
  } finally {
    await harness.dispose();
  }
});

test('ResizeObserver follows delayed content growth only while viewing the tail', async () => {
  const harness = await mountScrollHarness();
  try {
    harness.container.scrollHeight = 1_000;
    harness.container.scrollTop = 400;
    act(() => harness.browser.triggerResize());
    assert.equal(harness.container.scrollTop, 1_000);
    act(() => harness.browser.runAllFrames());

    act(() => harness.latest().setIsUserScrolledUp(true));
    harness.container.scrollHeight = 1_300;
    harness.container.scrollTop = 250;
    act(() => harness.browser.triggerResize());

    assert.equal(harness.container.scrollTop, 250);
    assert.equal(harness.browser.pendingFrames(), 0);
  } finally {
    await harness.dispose();
  }
});

test('Given a followed live CLI transcript, when polling reconciles a new message, then it stays pinned to the tail', async () => {
  const harness = await mountScrollHarness({ withMessage: true });
  try {
    act(() => harness.browser.runAllFrames());
    harness.container.scrollHeight = 1_100;

    await harness.pollExternalMessage('arrived through external live polling');

    assert.equal(harness.container.scrollTop, 1_100);
    assert.equal(harness.browser.pendingFrames(), 1, 'the polled render keeps correcting painted layout');

    harness.container.scrollHeight = 1_300;
    act(() => harness.browser.triggerResize());
    assert.equal(harness.container.scrollTop, 1_300, 'follows content growth after the polled update');
  } finally {
    await harness.dispose();
  }
});

test('Given a detached live CLI transcript, when polling updates and the user returns to the bottom, then follow-tail reattaches', async () => {
  const harness = await mountScrollHarness({ withMessage: true });
  try {
    act(() => harness.browser.runAllFrames());
    harness.container.scrollTop = 200;
    await act(async () => { await harness.latest().handleScroll(); });

    harness.container.scrollHeight = 1_100;
    await harness.pollExternalMessage('new output while reviewing older text');

    assert.equal(harness.container.scrollTop, 200);
    assert.equal(harness.latest().hasNewMessagesBelow, true);

    harness.container.scrollTop = 800;
    await act(async () => { await harness.latest().handleScroll(); });
    assert.equal(harness.latest().isUserScrolledUp, false);
    assert.equal(harness.latest().hasNewMessagesBelow, false);

    harness.container.scrollHeight = 1_300;
    await harness.pollExternalMessage('new output after returning to the tail');
    assert.equal(harness.container.scrollTop, 1_300);
  } finally {
    await harness.dispose();
  }
});
