import { createElement, useEffect, useState } from 'react';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';

import { readQueuedMessage, writeQueuedMessage } from '../components/chat/utils/chatStorage';
import { useQueuedMessageAutoSend } from '../hooks/useQueuedMessageAutoSend';
import { useSessionProtection } from '../hooks/useSessionProtection';
import { useSessionStore } from '../stores/useSessionStore';

import { useHostScopedSessionActivity } from './hostScopedSessionActivity';
import FleetSessionRoute, { useFleetHost } from './FleetSessionRoute';
import type {
  DriverOptions,
  MountRead,
  SurfaceState,
} from './mountedSessionDriverContract';
import { browserPersistedStateStorage } from './persistedHostState';
import { LOCAL_SESSION_ROUTE, REMOTE_SESSION_ROUTE } from './sessionRoute';

export const IDENTITY_URL = '/api/fleet/identity';

type MountedSessionFixture = {
  readonly inFlight: Promise<unknown>[];
  readonly mountReads: MountRead[];
  readonly requests: string[];
  readonly sent: unknown[];
  readonly markIdle: () => void;
  readonly markProcessing: () => void;
  readonly navigate: () => ((path: string) => void) | null;
  readonly state: () => SurfaceState | undefined;
  readonly tree: (path: string) => ReturnType<typeof createElement>;
  readonly writeDraft: (content: string) => void;
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** Production-wired route fixture used by the mounted session driver. */
export function createMountedSessionFixture(options: DriverOptions): MountedSessionFixture {
  const requests: string[] = [];
  const sent: unknown[] = [];
  const inFlight: Promise<unknown>[] = [];
  const mountReads: MountRead[] = [];
  let surface: SurfaceState | undefined;
  let writeDraft: ((content: string) => void) | undefined;
  let markProcessing: (() => void) | undefined;
  let markIdle: (() => void) | undefined;
  let navigateRef: ((path: string) => void) | null = null;

  globalThis.fetch = ((input: string | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    requests.push(url);
    if (init?.signal?.aborted) {
      return Promise.reject(new Error('aborted'));
    }
    if (url === IDENTITY_URL) {
      return Promise.resolve(options.identity === null
        ? new Response('not found', { status: 404 })
        : jsonResponse({ data: { installationId: options.identity } }));
    }
    const messageIds = [...options.messagesByUrl.entries()]
      .find(([prefix]) => url.startsWith(prefix))?.[1];
    return Promise.resolve(jsonResponse({
      data: {
        messages: (messageIds ?? []).map((id) => ({
          id,
          sessionId: 'session-42',
          timestamp: '2026-01-01T00:00:00Z',
          kind: 'text',
          role: 'assistant',
          provider: 'claude',
        })),
        total: (messageIds ?? []).length,
        hasMore: false,
      },
    }));
  }) as typeof fetch;

  /** Mirrors MainContent's host-qualified chat-surface key. */
  function ChatSurfaceHost() {
    const { activeSessionKey } = useFleetHost();
    return createElement(SessionSurface, { key: activeSessionKey ?? 'no-session' });
  }

  function NavigationProbe() {
    navigateRef = useNavigate();
    return null;
  }

  function SessionSurface() {
    const fleetHost = useFleetHost();
    const store = useSessionStore(fleetHost.storeScope);
    const { processingSessions, markProcessing: mark, markIdle: idle } = useSessionProtection();
    const scoped = useHostScopedSessionActivity(processingSessions, fleetHost.storeScope.hostId);
    const localId = fleetHost.activeSession?.localId ?? null;

    useQueuedMessageAutoSend({
      processingSessions,
      activeSessionKey: null,
      localHostId: fleetHost.localHostId,
      storage: browserPersistedStateStorage(),
      ws: { readyState: WebSocket.OPEN } as WebSocket,
      sendMessage: (message) => sent.push(message),
      markProcessing: mark,
    });

    useEffect(() => {
      if (localId === null) return;
      store.setActiveSession(localId);
      inFlight.push(store.fetchFromServer(localId, { limit: 10 }));
    }, [localId, store]);

    const [mountedDraft] = useState<string | null>(() => (
      localId === null ? null : readQueuedMessage(localId)?.content ?? null
    ));
    const mountKey = fleetHost.activeSessionKey;
    useEffect(() => {
      mountReads.push({ sessionKey: mountKey, draft: mountedDraft });
    }, [mountKey, mountedDraft]);

    surface = {
      localHostId: fleetHost.localHostId,
      routeKind: fleetHost.route.kind,
      storeHostId: fleetHost.storeScope.hostId,
      messageIds: localId === null ? [] : store.getMessages(localId).map((entry) => entry.id),
      draft: localId === null ? null : readQueuedMessage(localId)?.content ?? null,
      processingLocalIds: [...scoped.keys()],
    };
    writeDraft = (content) => {
      if (localId !== null) writeQueuedMessage(localId, { content });
    };
    markProcessing = () => {
      if (localId !== null) mark({ hostId: fleetHost.storeScope.hostId, localId });
    };
    markIdle = () => {
      if (localId !== null) idle({ hostId: fleetHost.storeScope.hostId, localId });
    };
    return null;
  }

  const tree = (path: string) => createElement(
    I18nextProvider,
    { i18n: options.i18n },
    createElement(
      MemoryRouter,
      { initialEntries: [path] },
      createElement(NavigationProbe),
      createElement(
        Routes,
        null,
        createElement(Route, {
          path: '/',
          element: createElement(FleetSessionRoute, null, createElement(ChatSurfaceHost)),
        }),
        createElement(Route, {
          path: LOCAL_SESSION_ROUTE,
          element: createElement(FleetSessionRoute, null, createElement(ChatSurfaceHost)),
        }),
        createElement(Route, {
          path: REMOTE_SESSION_ROUTE,
          element: createElement(FleetSessionRoute, null, createElement(ChatSurfaceHost)),
        }),
      ),
    ),
  );

  return {
    inFlight,
    mountReads,
    requests,
    sent,
    markIdle: () => markIdle?.(),
    markProcessing: () => markProcessing?.(),
    navigate: () => navigateRef,
    state: () => surface,
    tree,
    writeDraft: (content) => writeDraft?.(content),
  };
}
