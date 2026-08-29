import assert from 'node:assert/strict';
import test from 'node:test';

import { createElement, useEffect } from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';

import type { ServerEvent } from '../../contexts/WebSocketContext';
import WebSocketContext from '../../contexts/WebSocketContext';

import { FLEET_HOSTS_ENDPOINT, FLEET_RESYNC_MESSAGE, FLEET_SUBSCRIBE_MESSAGE } from './hostFrames';
import {
  deltaFrame,
  LOCAL_HOST_ID,
  paneRow,
  PEER_A_HOST_ID,
  PEER_B_HOST_ID,
  peerDescriptor,
  sessionRow,
  snapshotFrame,
} from './hostCatalog.testSupport';
import { useFleetHostDiscovery, type FleetHostDiscovery } from './useFleetHostDiscovery';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const roster = {
  localHostId: LOCAL_HOST_ID,
  hosts: [
    peerDescriptor(LOCAL_HOST_ID, 'workstation'),
    peerDescriptor(PEER_A_HOST_ID, 'studio'),
    peerDescriptor(PEER_B_HOST_ID, 'studio'),
  ],
};

type Harness = {
  readonly latest: () => FleetHostDiscovery;
  readonly emit: (event: ServerEvent) => Promise<void>;
  readonly sent: readonly unknown[];
  readonly fetched: readonly string[];
  readonly renders: () => number;
  readonly renderer: ReactTestRenderer;
};

async function mount(options: {
  readonly respond: (url: string) => Response | Promise<Response>;
  readonly isConnected?: boolean;
}): Promise<Harness & { readonly dispose: () => Promise<void> }> {
  const originalFetch = globalThis.fetch;
  const listeners = new Set<(event: ServerEvent) => void>();
  const sent: unknown[] = [];
  const fetched: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    fetched.push(url);
    return await options.respond(url);
  }) as typeof globalThis.fetch;

  let value: FleetHostDiscovery | null = null;
  let renders = 0;
  function Probe() {
    const discovery = useFleetHostDiscovery();
    useEffect(() => { value = discovery; }, [discovery]);
    value = discovery;
    renders += 1;
    return null;
  }

  let renderer: ReactTestRenderer | null = null;
  await act(async () => {
    renderer = TestRenderer.create(createElement(
      WebSocketContext.Provider,
      {
        value: {
          ws: null,
          latestMessage: null,
          isConnected: options.isConnected ?? true,
          sendMessage: (message: unknown) => { sent.push(message); },
          subscribe: (listener: (event: ServerEvent) => void) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
        } as never,
      },
      createElement(Probe),
    ));
    await tick();
  });

  return {
    latest: () => {
      assert.ok(value, 'the hook published a value');
      return value;
    },
    emit: async (event: ServerEvent) => {
      await act(async () => {
        for (const listener of [...listeners]) listener(event);
        await tick();
      });
    },
    sent,
    fetched,
    renders: () => renders,
    renderer: renderer!,
    dispose: async () => {
      await act(async () => { renderer!.unmount(); await tick(); });
      globalThis.fetch = originalFetch;
    },
  };
}

test('Given a server without the fleet surface, when the hook mounts, then the browser stays single-host', async () => {
  const harness = await mount({ respond: () => jsonResponse({ error: 'not found' }, 404) });

  try {
    assert.deepEqual(harness.fetched, [FLEET_HOSTS_ENDPOINT]);
    assert.equal(harness.latest().catalog.hosts.size, 0);
    assert.equal(harness.latest().hasRemoteHosts, false);
    assert.equal(harness.latest().catalog.localHostId, null);
  } finally {
    await harness.dispose();
  }
});

test('Given the roster over REST, when it lands, then hosts appear and the stream is subscribed once', async () => {
  const harness = await mount({ respond: () => jsonResponse({ success: true, data: roster }) });

  try {
    assert.equal(harness.latest().catalog.hosts.size, 3);
    assert.equal(harness.latest().hasRemoteHosts, true);
    assert.deepEqual(
      harness.sent.filter((message) => (message as { type?: string }).type === FLEET_SUBSCRIBE_MESSAGE).length,
      1,
    );
  } finally {
    await harness.dispose();
  }
});

test('Given a stream snapshot, when one peer is replaced, then the other peer entry keeps its identity', async () => {
  const harness = await mount({ respond: () => jsonResponse(roster) });

  try {
    await harness.emit(snapshotFrame(PEER_A_HOST_ID, 1, {
      panes: [paneRow('/tmp/peer-a.sock', 'omg')],
    }) as ServerEvent);
    await harness.emit(snapshotFrame(PEER_B_HOST_ID, 1, {
      panes: [paneRow('/tmp/peer-b.sock', 'omg')],
    }) as ServerEvent);
    const peerBEntry = harness.latest().catalog.hosts.get(PEER_B_HOST_ID);

    await harness.emit(snapshotFrame(PEER_A_HOST_ID, 2, { panes: [] }) as ServerEvent);

    assert.equal(harness.latest().catalog.hosts.get(PEER_A_HOST_ID)?.rows.panes.length, 0);
    assert.equal(harness.latest().catalog.hosts.get(PEER_B_HOST_ID), peerBEntry);
  } finally {
    await harness.dispose();
  }
});

test('Given one peer failing then recovering, when frames arrive, then only that host changes', async () => {
  const harness = await mount({ respond: () => jsonResponse(roster) });

  try {
    await harness.emit(snapshotFrame(PEER_A_HOST_ID, 1, {
      sessions: [sessionRow('gjc-session', 'refactor')],
    }) as ServerEvent);
    await harness.emit(snapshotFrame(PEER_B_HOST_ID, 1, {
      sessions: [sessionRow('gjc-session', 'refactor')],
    }) as ServerEvent);
    const peerBBefore = harness.latest().catalog.hosts.get(PEER_B_HOST_ID);

    await harness.emit({
      kind: 'fleet.host_state',
      host: peerDescriptor(PEER_A_HOST_ID, 'studio', 'offline'),
    } as ServerEvent);
    assert.equal(harness.latest().catalog.hosts.get(PEER_A_HOST_ID)?.descriptor.state, 'offline');
    assert.equal(
      harness.latest().catalog.hosts.get(PEER_A_HOST_ID)?.rows.sessions.length,
      1,
      'an offline peer keeps its last rows',
    );

    await harness.emit({
      kind: 'fleet.host_state',
      host: peerDescriptor(PEER_A_HOST_ID, 'studio', 'online'),
    } as ServerEvent);
    await harness.emit(snapshotFrame(PEER_A_HOST_ID, 5, {
      sessions: [sessionRow('gjc-session', 'refactor'), sessionRow('second', 'second')],
    }) as ServerEvent);

    assert.equal(harness.latest().catalog.hosts.get(PEER_A_HOST_ID)?.descriptor.state, 'online');
    assert.equal(harness.latest().catalog.hosts.get(PEER_A_HOST_ID)?.rows.sessions.length, 2);
    assert.equal(harness.latest().catalog.hosts.get(PEER_B_HOST_ID), peerBBefore, 'peer B never re-rendered');
  } finally {
    await harness.dispose();
  }
});

test('Given a gapped delta, when it arrives, then a resync is requested for that host alone', async () => {
  const harness = await mount({ respond: () => jsonResponse(roster) });

  try {
    await harness.emit(snapshotFrame(PEER_A_HOST_ID, 1, {}) as ServerEvent);
    await harness.emit(deltaFrame(PEER_A_HOST_ID, { prevRevision: 8, revision: 9 }, []) as ServerEvent);

    assert.deepEqual(
      harness.sent.filter((message) => (message as { type?: string }).type === FLEET_RESYNC_MESSAGE),
      [{ type: FLEET_RESYNC_MESSAGE, hostId: PEER_A_HOST_ID, reason: 'gap' }],
    );
    assert.equal(harness.latest().catalog.hosts.get(PEER_A_HOST_ID)?.sync, 'syncing');
    assert.equal(harness.latest().catalog.hosts.get(PEER_B_HOST_ID)?.sync, 'syncing', 'peer B never snapshotted');
  } finally {
    await harness.dispose();
  }
});

test('Given a websocket reconnect, when it is announced, then the roster is refetched and resubscribed', async () => {
  const harness = await mount({ respond: () => jsonResponse(roster) });

  try {
    await harness.emit({ kind: 'websocket_reconnected', timestamp: 1 } as ServerEvent);

    assert.deepEqual(harness.fetched, [FLEET_HOSTS_ENDPOINT, FLEET_HOSTS_ENDPOINT]);
    assert.equal(
      harness.sent.filter((message) => (message as { type?: string }).type === FLEET_SUBSCRIBE_MESSAGE).length,
      2,
    );
    assert.equal(harness.latest().catalog.hosts.size, 3);
  } finally {
    await harness.dispose();
  }
});

test('Given a roster request in flight at unmount, when it resolves, then nothing is published', async () => {
  const pending: Array<(response: Response) => void> = [];
  let deferred = false;
  const harness = await mount({
    respond: () => (deferred
      ? new Promise<Response>((resolve) => { pending.push(resolve); })
      : jsonResponse(roster)),
  });

  try {
    deferred = true;
    await act(async () => { harness.latest().refresh(); await tick(); });
    assert.equal(pending.length, 1, 'the refresh issued one request');
    const rendersBeforeUnmount = harness.renders();

    await harness.dispose();
    pending[0]!(jsonResponse({ localHostId: LOCAL_HOST_ID, hosts: [] }));
    await tick();

    assert.equal(harness.renders(), rendersBeforeUnmount, 'an unmounted response cannot publish');
  } finally {
    deferred = false;
  }
});
