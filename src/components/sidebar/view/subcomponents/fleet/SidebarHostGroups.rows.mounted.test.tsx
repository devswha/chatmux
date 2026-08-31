import assert from 'node:assert/strict';
import test from 'node:test';

import type { DragEndEvent } from '@dnd-kit/core';
import { act } from 'react-test-renderer';

import type { ServerEvent } from '../../../../../contexts/WebSocketContext';
import {
  LOCAL_HOST_ID,
  paneRow,
  PEER_A_HOST_ID,
  PEER_B_HOST_ID,
  peerDescriptor,
  sessionRow,
  snapshotFrame,
} from '../../../../../fleet/discovery/hostCatalog.testSupport';
import {
  LIVE_SESSION_ORDER_KEY,
  createSessionOrderId,
} from '../../../utils/sessionOrder';
import SortableSessionRow from '../SortableSessionRow';

import {
  groupHostIds,
  jsonResponse,
  mountHostGroups,
  remoteRows,
  rosterBody,
  visibleText,
} from './hostGroups.testSupport';

function installStorage(storage: Storage) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  return () => {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  };
}

function sortableIds(
  harness: Awaited<ReturnType<typeof mountHostGroups>>,
  hostId: string,
): string[] {
  const section = harness.renderer.root.find(
    (node) => typeof node.type === 'string' && node.props['data-host-id'] === hostId,
  );
  return section.findAllByType(SortableSessionRow).map((row) => row.props.id as string);
}

function dragRemote(
  harness: Awaited<ReturnType<typeof mountHostGroups>>,
  hostId: string,
  activeId: string,
  overId: string,
): void {
  const section = harness.renderer.root.find(
    (node) => typeof node.type === 'string' && node.props['data-host-id'] === hostId,
  );
  const contexts = section.findAll((node) => (
    typeof node.props.onDragEnd === 'function'
    && Array.isArray(node.props.sensors)
    && node.props.collisionDetection
  ));
  assert.equal(contexts.length, 1, 'the remote host owns one production DnD context');
  contexts[0]!.props.onDragEnd({
    active: { id: activeId },
    over: { id: overId },
  } as DragEndEvent);
}

async function collisionHarness(states: Parameters<typeof rosterBody>[0] = {}) {
  const harness = await mountHostGroups({ roster: () => jsonResponse(rosterBody(states)) });
  const peerAPane = { ...paneRow('/tmp/peer-a.sock', 'omg'), kind: 'gjc' };
  const peerBPane = { ...paneRow('/tmp/peer-b.sock', 'omg'), kind: 'gjc' };
  await harness.emit(snapshotFrame(PEER_A_HOST_ID, 1, {
    sessions: [sessionRow('gjc-session', 'refactor the parser')],
    panes: [peerAPane],
  }) as ServerEvent);
  await harness.emit(snapshotFrame(PEER_B_HOST_ID, 1, {
    sessions: [sessionRow('gjc-session', 'refactor the parser')],
    panes: [peerBPane],
  }) as ServerEvent);
  return harness;
}

test('Given two peers colliding on every label, when groups render, then each row names its own host', async () => {
  const harness = await collisionHarness();

  try {
    assert.deepEqual(groupHostIds(harness), [LOCAL_HOST_ID, PEER_A_HOST_ID, PEER_B_HOST_ID]);
    const peerA = remoteRows(harness, PEER_A_HOST_ID);
    const peerB = remoteRows(harness, PEER_B_HOST_ID);
    assert.equal(peerA.length, 1, 'the pane row represents its session once');
    const nameA = String(peerA[0]?.['aria-label']);
    const nameB = String(peerB[0]?.['aria-label']);
    assert.match(nameA, /omg/, 'the row keeps its own label');
    assert.match(nameA, /studio/, 'the row exposes its host label');
    assert.notEqual(nameA, nameB, 'identical labels on two hosts are never ambiguous');
    assert.match(nameA, new RegExp(PEER_A_HOST_ID.slice(0, 8)), 'peers sharing a label are disambiguated');
    assert.match(nameB, new RegExp(PEER_B_HOST_ID.slice(0, 8)));
  } finally {
    await harness.dispose();
  }
});

test('Given an online peer row, when it is activated, then the host-qualified route opens', async () => {
  const harness = await collisionHarness();

  try {
    const row = remoteRows(harness, PEER_B_HOST_ID)[0];
    assert.equal(row?.type, 'button', 'rows are native buttons, so Enter and Space activate them');
    assert.equal(row?.disabled, false);

    await harness.emit({ kind: 'noop' } as ServerEvent);
    row?.onClick?.();

    assert.equal(
      harness.paths[harness.paths.length - 1],
      `/hosts/${PEER_B_HOST_ID}/session/gjc-session`,
      'selecting a remote row targets its owning host, never the local one',
    );
    assert.deepEqual(
      harness.openedTerminals,
      [],
      'a pane with a catalogued transcript opens the conversation before its terminal',
    );
    assert.equal(
      harness.openedTranscripts,
      1,
      'opening a conversation clears any terminal takeover that would hide it',
    );
  } finally {
    await harness.dispose();
  }
});

test('Given two remote live rows, when one is dragged, then local-style order persists across remounts', async () => {
  const values = new Map<string, string>();
  const restoreStorage = installStorage({
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
    clear: () => { values.clear(); },
    key: (index) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  });
  const firstPane = {
    ...paneRow('/tmp/peer-a.sock', 'alpha'),
    localId: 'remote-alpha',
    providerSessionId: null,
    kind: 'codex',
  };
  const secondPane = {
    ...paneRow('/tmp/peer-a.sock', 'zeta'),
    localId: 'remote-zeta',
    providerSessionId: null,
    kind: 'shell',
    tmux: { ...paneRow('/tmp/peer-a.sock', 'zeta').tmux, paneId: '%2' },
    process: { pid: 5252, startedAtMs: 1_700_000_005_252 },
  };
  const expected = [
    createSessionOrderId(firstPane.localId, firstPane.tmux, PEER_A_HOST_ID),
    createSessionOrderId(secondPane.localId, secondPane.tmux, PEER_A_HOST_ID),
  ];
  let harness: Awaited<ReturnType<typeof mountHostGroups>> | null = null;
  let remounted: Awaited<ReturnType<typeof mountHostGroups>> | null = null;

  try {
    harness = await mountHostGroups({ roster: () => jsonResponse(rosterBody()) });
    await harness.emit(snapshotFrame(PEER_A_HOST_ID, 1, {
      panes: [secondPane, firstPane],
    }) as ServerEvent);

    assert.deepEqual(sortableIds(harness, PEER_A_HOST_ID), expected, 'remote rows use the sortable local row shell');
    const section = harness.renderer.root.find(
      (node) => typeof node.type === 'string' && node.props['data-host-id'] === PEER_A_HOST_ID,
    );
    assert.equal(
      section.findAllByType(SortableSessionRow).filter((row) => row.props.disabled === false).length,
      2,
      'each healthy remote row exposes the same enabled drag handle as a local row',
    );

    await act(async () => { dragRemote(harness!, PEER_A_HOST_ID, expected[1]!, expected[0]!); });
    const reordered = [expected[1]!, expected[0]!];
    assert.deepEqual(sortableIds(harness, PEER_A_HOST_ID), reordered);
    assert.deepEqual(
      JSON.parse(values.get(LIVE_SESSION_ORDER_KEY) ?? '{}'),
      { version: 2, entries: reordered },
      'remote order is stored through the same versioned sidebar contract',
    );

    await harness.dispose();
    harness = null;
    remounted = await mountHostGroups({ roster: () => jsonResponse(rosterBody()) });
    await remounted.emit(snapshotFrame(PEER_A_HOST_ID, 1, {
      panes: [secondPane, firstPane],
    }) as ServerEvent);
    assert.deepEqual(
      sortableIds(remounted, PEER_A_HOST_ID),
      reordered,
      'a browser reload restores the remote host order',
    );
  } finally {
    if (harness) await harness.dispose();
    if (remounted) await remounted.dispose();
    restoreStorage();
  }
});

test('Given one peer offline, when groups render, then its rows stay visible with every action disabled', async () => {
  const harness = await collisionHarness();

  try {
    await harness.emit({
      kind: 'fleet.host_state',
      host: peerDescriptor(PEER_A_HOST_ID, 'studio', 'offline'),
    } as ServerEvent);

    const offline = remoteRows(harness, PEER_A_HOST_ID);
    assert.equal(offline.length, 1, 'an offline host keeps its last known rows on screen');
    assert.equal(offline[0]?.disabled, true);
    assert.equal(offline[0]?.['aria-disabled'], true);
    assert.equal(remoteRows(harness, PEER_B_HOST_ID)[0]?.disabled, false, 'the healthy peer stays actionable');

    const pathsBefore = [...harness.paths];
    offline[0]?.onClick?.();
    assert.deepEqual(harness.paths, pathsBefore, 'a disabled row cannot retarget the view');
  } finally {
    await harness.dispose();
  }
});

test('Given a peer whose stream gapped, when the delta lands, then only that group is marked syncing', async () => {
  const harness = await collisionHarness();

  try {
    await harness.emit({
      kind: 'fleet.catalog.delta',
      hostId: PEER_A_HOST_ID,
      epoch: `epoch-${PEER_A_HOST_ID}`,
      prevRevision: 8,
      revision: 9,
      changes: [],
    } as ServerEvent);

    assert.equal(remoteRows(harness, PEER_A_HOST_ID)[0]?.disabled, true);
    assert.equal(remoteRows(harness, PEER_B_HOST_ID)[0]?.disabled, false);
    assert.match(visibleText(harness), /Syncing/i);
    assert.deepEqual(
      harness.sent.filter((message) => (message as { type?: string }).type === 'fleet.resync'),
      [{ type: 'fleet.resync', hostId: PEER_A_HOST_ID, reason: 'gap' }],
    );
  } finally {
    await harness.dispose();
  }
});

test('Given a peer flooding rows, when the snapshot lands, then only that group reports backpressure', async () => {
  const harness = await collisionHarness();

  try {
    await harness.emit(snapshotFrame(PEER_A_HOST_ID, 2, {
      sessions: Array.from({ length: 520 }, (_unused, index) => sessionRow(`session-${index}`, `s${index}`)),
    }) as ServerEvent);

    const peerASection = harness.renderer.root.find(
      (node) => typeof node.type === 'string' && node.props['data-host-id'] === PEER_A_HOST_ID,
    );
    const peerBSection = harness.renderer.root.find(
      (node) => typeof node.type === 'string' && node.props['data-host-id'] === PEER_B_HOST_ID,
    );
    assert.equal(peerASection.props['data-host-truncated'], 'true');
    assert.equal(peerBSection.props['data-host-truncated'], 'false');
  } finally {
    await harness.dispose();
  }
});
