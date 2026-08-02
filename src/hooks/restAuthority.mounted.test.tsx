import assert from 'node:assert/strict';
import test from 'node:test';

import { createElement, useEffect } from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';

import type { TmuxPaneIdentity } from '../../shared/tmux';
import { useExternalCliSessions, type ExternalCliSession } from '../components/sidebar/hooks/useExternalCliSessions';
import WebSocketContext from '../contexts/WebSocketContext';
import type { ServerEvent } from '../contexts/WebSocketContext';
import { api } from '../utils/api';

import { useProjectsState } from './useProjectsState';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

type PendingRequest = {
  signal?: AbortSignal;
  resolve: (response: Response) => void;
};

function requestQueue() {
  const requests: PendingRequest[] = [];
  return {
    requests,
    request(signal?: AbortSignal): Promise<Response> {
      return new Promise((resolve) => requests.push({ signal, resolve }));
    },
  };
}

type TimerHarness = {
  callbacks: Map<number, () => void>;
  restore: () => void;
};

function installBrowserGlobals(): TimerHarness {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const callbacks = new Map<number, () => void>();
  let nextTimer = 1;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      setInterval(callback: () => void) {
        const id = nextTimer++;
        callbacks.set(id, callback);
        return id;
      },
      clearInterval(id: number) {
        callbacks.delete(id);
      },
    },
  });
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: () => null,
      setItem: () => undefined,
    },
  });
  return {
    callbacks,
    restore: () => {
      if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
      else Reflect.deleteProperty(globalThis, 'window');
      if (originalLocalStorage) Object.defineProperty(globalThis, 'localStorage', originalLocalStorage);
      else Reflect.deleteProperty(globalThis, 'localStorage');
    },
  };
}

const tmux: TmuxPaneIdentity = {
  socketPath: '/tmp/chatmux-test.sock',
  sessionId: '$1',
  windowId: '@1',
  paneId: '%1',
};

const externalPayload = (pid: number) => ({
  success: true,
  data: {
    discovery: { ok: true },
    externalSessions: [{
      tmuxName: 'qa-external',
      tmux,
      process: { pid, startedAtMs: 1_700_000_000_000 + pid },
      kind: 'claude',
      presence: 'present',
      activity: 'error',
      transcriptSessionId: `transcript-${pid}`,
      attachCapability: `capability-${pid}`,
    }],
  },
});

const externalSnapshotEvent = {
  kind: 'discovery.v2.snapshot',
  version: 2,
  discovery: {
    version: 2,
    epoch: 'epoch-external',
    globalRevision: 1,
    terminals: [],
    tmuxRows: [{
      key: 'external-tmux',
      lane: 'external',
      tmuxName: 'qa-external',
      tmux,
      process: null,
      kind: 'shell',
      providerSessionId: null,
      activity: 'unknown',
      cwd: '/workspace/project',
      presence: 'present',
    }],
    sourceDescriptors: [{ runtime: 'tmux', sourceId: 'tmux.local', readiness: 'ready' }],
    sourceLanes: [{
      lane: 'external',
      sourceId: 'tmux.local',
      runtime: 'tmux',
      readiness: 'ready',
      capabilities: { discovery: true, output: true, actions: true, attach: true, create: false },
      sourceLaneRevision: 1,
      lastOkGlobalRevision: 1,
      coverage: 'authoritative',
      consecutiveFailures: 0,
    }],
    coverageByLane: {
      external: {
        lane: 'external',
        state: 'complete',
        expectedSourceLaneKeys: ['external\u0000tmux.local'],
        authoritativeSourceLaneKeys: ['external\u0000tmux.local'],
        retainedSourceLaneKeys: [],
        unavailableSourceLaneKeys: [],
      },
      live: {
        lane: 'live',
        state: 'complete',
        expectedSourceLaneKeys: [],
        authoritativeSourceLaneKeys: [],
        retainedSourceLaneKeys: [],
        unavailableSourceLaneKeys: [],
      },
    },
  },
} as ServerEvent;

const livePayload = (pid: number) => ({
  success: true,
  data: {
    discovery: { ok: true },
    liveSessions: [{
      id: 'qa-live',
      tmuxName: 'qa-live',
      tmux,
      process: { pid, startedAtMs: 1_700_000_000_000 + pid },
      presence: 'present',
      claim: 'lineage',
      kind: 'interactive',
      model: 'anthropic/claude-opus-5',
      effort: 'high',
      running: true,
      error: true,
    }],
  },
});

const malformedExternalPayload = {
  success: true,
  data: { discovery: { ok: true }, externalSessions: { stale: true } },
};
const malformedLivePayload = {
  success: true,
  data: { discovery: { ok: true }, liveSessions: { stale: true } },
};

test('healthy discovery retains the exact REST attach capability for shell panes', async () => {
  const timers = installBrowserGlobals();
  const queue = requestQueue();
  const originalExternalSessions = api.externalSessions;
  (api as typeof api & { externalSessions: (signal?: AbortSignal) => Promise<Response> }).externalSessions =
    (signal?: AbortSignal) => queue.request(signal);
  const listeners = new Set<(event: ServerEvent) => void>();
  let latest: { sessions: ExternalCliSession[] } | null = null;
  let renderer: ReactTestRenderer | null = null;

  function Probe() {
    const value = useExternalCliSessions();
    useEffect(() => { latest = value; }, [value]);
    return null;
  }

  try {
    await act(async () => {
      renderer = TestRenderer.create(createElement(
        WebSocketContext.Provider,
        {
          value: {
            ws: null,
            sendMessage: () => undefined,
            subscribe: (listener: (event: ServerEvent) => void) => {
              listeners.add(listener);
              return () => listeners.delete(listener);
            },
            latestMessage: null,
            isConnected: true,
          } as never,
        },
        createElement(Probe),
      ));
      await tick();
    });
    assert.equal(queue.requests.length, 1);

    await act(async () => {
      for (const listener of listeners) listener(externalSnapshotEvent);
      await tick();
    });
    assert.equal(queue.requests.length, 2);
    assert.equal(queue.requests[1]!.signal?.aborted, false);

    await act(async () => {
      queue.requests[1]!.resolve(jsonResponse(externalPayload(42)));
      await tick();
    });
    assert.equal(latest!.sessions[0]?.authority, 'stream');
    assert.equal(latest!.sessions[0]?.process, null);
    assert.equal(latest!.sessions[0]?.attachCapability, 'capability-42');
  } finally {
    if (renderer) await act(async () => { renderer!.unmount(); });
    (api as typeof api & { externalSessions: typeof originalExternalSessions }).externalSessions = originalExternalSessions;
    timers.restore();
  }
});

test('mounted external hook fences malformed, deferred, recovered, and unmounted REST responses', async () => {
  const timers = installBrowserGlobals();
  const queue = requestQueue();
  const originalExternalSessions = api.externalSessions;
  (api as typeof api & { externalSessions: (signal?: AbortSignal) => Promise<Response> }).externalSessions =
    (signal?: AbortSignal) => queue.request(signal);

  let latest: ReturnType<typeof useExternalCliSessions> | null = null;
  const published: ReturnType<typeof useExternalCliSessions>['sessions'][] = [];
  let renderer: ReactTestRenderer | null = null;

  function Probe() {
    const value = useExternalCliSessions((sessions) => published.push(sessions));
    useEffect(() => { latest = value; }, [value]);
    return null;
  }

  const websocketValue = {
    ws: null,
    sendMessage: () => undefined,
    subscribe: () => () => undefined,
    latestMessage: null,
    isConnected: false,
  };

  try {
    await act(async () => {
      renderer = TestRenderer.create(createElement(
        WebSocketContext.Provider,
        { value: websocketValue as never },
        createElement(Probe),
      ));
      await tick();
    });
    assert.equal(queue.requests.length, 1);

    await act(async () => {
      queue.requests[0]!.resolve(jsonResponse(externalPayload(41)));
      await tick();
    });
    assert.equal(latest!.sessions[0]?.process?.pid, 41);
    assert.equal(latest!.sessions[0]?.activity, 'error');

    await act(async () => { latest!.refresh(); await tick(); });
    await act(async () => { latest!.refresh(); await tick(); });
    assert.equal(queue.requests.length, 3);
    assert.equal(queue.requests[1]!.signal?.aborted, true);

    await act(async () => {
      queue.requests[2]!.resolve(jsonResponse(malformedExternalPayload));
      await tick();
    });
    assert.equal(latest!.discoveryOk, false);
    assert.equal(latest!.sessions[0]?.process, null);
    assert.equal(latest!.sessions[0]?.activity, 'unknown');
    assert.equal(latest!.sessions[0]?.authority, 'none');
    assert.equal(latest!.sessions[0]?.transcriptSessionId, undefined);
    assert.equal(latest!.sessions[0]?.attachCapability, undefined);

    await act(async () => {
      queue.requests[1]!.resolve(jsonResponse(externalPayload(42)));
      await tick();
    });
    assert.equal(latest!.sessions[0]?.process, null, 'late success cannot revive malformed authority');

    await act(async () => { latest!.refresh(); await tick(); });
    await act(async () => {
      queue.requests[3]!.resolve(jsonResponse(externalPayload(43)));
      await tick();
    });
    assert.equal(latest!.discoveryOk, true);
    assert.deepEqual(latest!.sessions[0]?.process, {
      pid: 43,
      startedAtMs: 1_700_000_000_043,
    });

    await act(async () => { latest!.refresh(); await tick(); });
    await act(async () => { renderer!.unmount(); await tick(); });
    const publishCount = published.length;
    queue.requests[4]!.resolve(jsonResponse(externalPayload(44)));
    await tick();
    assert.equal(published.length, publishCount, 'unmounted response cannot publish');
  } finally {
    if (renderer) await act(async () => { renderer!.unmount(); });
    (api as typeof api & { externalSessions: typeof originalExternalSessions }).externalSessions = originalExternalSessions;
    timers.restore();
  }
});

test('mounted live hook atomically clears malformed authority and ignores late or unmounted responses', async () => {
  const timers = installBrowserGlobals();
  const queue = requestQueue();
  const originalLiveSessions = api.liveSessions;
  const originalProjects = api.projects;
  (api as typeof api & { liveSessions: (signal?: AbortSignal) => Promise<Response> }).liveSessions =
    (signal?: AbortSignal) => queue.request(signal);
  (api as typeof api & { projects: () => Promise<Response> }).projects = async () => jsonResponse([]);

  let latest: ReturnType<typeof useProjectsState> | null = null;
  let renderCount = 0;
  let renderer: ReactTestRenderer | null = null;

  const navigate = (() => undefined) as never;
  const subscribe = () => () => undefined;
  const sendMessage = () => undefined;
  const activeSessions = new Map();

  function Probe() {
    const value = useProjectsState({
      navigate,
      subscribe,
      sendMessage,
      isConnected: false,
      isMobile: false,
      activeSessions,
    });
    useEffect(() => {
      latest = value;
      renderCount += 1;
    }, [value]);
    return null;
  }

  try {
    await act(async () => {
      renderer = TestRenderer.create(createElement(Probe));
      await tick();
    });
    assert.equal(queue.requests.length, 1);

    await act(async () => {
      queue.requests[0]!.resolve(jsonResponse(livePayload(51)));
      await tick();
    });
    assert.equal(latest!.sidebarSharedProps.liveSessionTargets.get('qa-live')?.process.pid, 51);
    assert.equal(latest!.sidebarSharedProps.liveSessionRunning.has('qa-live'), true);
    assert.equal(latest!.sidebarSharedProps.liveSessionErrors.has('qa-live'), true);

    const poll = [...timers.callbacks.values()].find((callback) => {
      const before = queue.requests.length;
      callback();
      return queue.requests.length > before;
    });
    assert.ok(poll, 'fallback polling callback is installed');
    await act(async () => { await tick(); });
    assert.equal(queue.requests.length, 2);

    poll!();
    await act(async () => { await tick(); });
    assert.equal(queue.requests.length, 3);
    assert.equal(queue.requests[1]!.signal?.aborted, true);

    await act(async () => {
      queue.requests[2]!.resolve(jsonResponse(malformedLivePayload));
      await tick();
    });
    const unavailable = latest!.sidebarSharedProps;
    assert.equal(unavailable.liveSessionPresence.get('qa-live'), 'stale');
    assert.equal(unavailable.liveSessionTargets.size, 0);
    assert.equal(unavailable.liveSessionModels.size, 0);
    assert.equal(unavailable.liveSessionEfforts.size, 0);
    assert.equal(unavailable.liveSessionLineage.size, 0);
    assert.equal(unavailable.liveSessionKinds.size, 0);
    assert.equal(unavailable.liveSessionRunning.size, 0);
    assert.equal(unavailable.liveSessionErrors.size, 0);

    await act(async () => {
      queue.requests[1]!.resolve(jsonResponse(livePayload(52)));
      await tick();
    });
    assert.equal(latest!.sidebarSharedProps.liveSessionTargets.size, 0, 'late success cannot revive malformed authority');

    poll!();
    await act(async () => { await tick(); });
    await act(async () => {
      queue.requests[3]!.resolve(jsonResponse(livePayload(53)));
      await tick();
    });
    assert.equal(latest!.sidebarSharedProps.liveSessionTargets.get('qa-live')?.process.pid, 53);

    poll!();
    await act(async () => { await tick(); });
    const rendersBeforeUnmount = renderCount;
    await act(async () => { renderer!.unmount(); await tick(); });
    queue.requests[4]!.resolve(jsonResponse(livePayload(54)));
    await tick();
    assert.equal(renderCount, rendersBeforeUnmount, 'unmounted response cannot publish');
  } finally {
    if (renderer) await act(async () => { renderer!.unmount(); });
    (api as typeof api & { liveSessions: typeof originalLiveSessions }).liveSessions = originalLiveSessions;
    (api as typeof api & { projects: typeof originalProjects }).projects = originalProjects;
    timers.restore();
  }
});
