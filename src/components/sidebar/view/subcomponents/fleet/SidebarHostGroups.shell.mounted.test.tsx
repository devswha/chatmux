import assert from 'node:assert/strict';
import test from 'node:test';

import { createElement } from 'react';
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
  groupHostIds,
  jsonResponse,
  mountHostGroups,
  remoteRows,
  rosterBody,
  visibleText,
} from './hostGroups.testSupport';

test('Given a server with no fleet surface, when the sidebar renders, then the local sections stand alone', async () => {
  const harness = await mountHostGroups({ roster: () => jsonResponse({ error: 'not found' }, 404) });

  try {
    assert.deepEqual(groupHostIds(harness), [], 'a single-machine install shows no host chrome');
    assert.equal(
      harness.renderer.root.findAll((node) => node.props['data-local-sections'] === 'true').length,
      1,
      'the existing local sidebar sections still render',
    );
  } finally {
    await harness.dispose();
  }
});

test('Given a host filter, when a peer is selected, then only that group renders and All restores every host', async () => {
  const harness = await mountHostGroups({ roster: () => jsonResponse(rosterBody()) });

  try {
    await harness.emit(snapshotFrame(PEER_A_HOST_ID, 1, {
      panes: [paneRow('/tmp/peer-a.sock', 'omg')],
    }) as ServerEvent);
    const chips = harness.renderer.root.findAll(
      (node) => node.type === 'button' && typeof node.props['data-host-filter'] === 'string',
    );
    assert.deepEqual(
      chips.map((chip) => chip.props['data-host-filter']),
      ['all', LOCAL_HOST_ID, PEER_A_HOST_ID, PEER_B_HOST_ID],
      'every host stays selectable, including the local one',
    );

    await act(async () => {
      chips.find((chip) => chip.props['data-host-filter'] === PEER_A_HOST_ID)?.props.onClick();
    });
    assert.deepEqual(groupHostIds(harness), [PEER_A_HOST_ID]);
    assert.equal(
      harness.renderer.root.find(
        (node) => node.type === 'button' && node.props['data-host-filter'] === PEER_A_HOST_ID,
      ).props['aria-pressed'],
      true,
    );

    await act(async () => {
      harness.renderer.root.find(
        (node) => node.type === 'button' && node.props['data-host-filter'] === 'all',
      ).props.onClick();
    });
    assert.deepEqual(groupHostIds(harness), [LOCAL_HOST_ID, PEER_A_HOST_ID, PEER_B_HOST_ID]);
  } finally {
    await harness.dispose();
  }
});

test('Given an empty peer and a connecting peer, when groups render, then empty reads apart from unavailable', async () => {
  const harness = await mountHostGroups({
    roster: () => jsonResponse(rosterBody({ peerB: 'connecting' })),
  });

  try {
    await harness.emit(snapshotFrame(PEER_A_HOST_ID, 1, { sessions: [], panes: [] }) as ServerEvent);

    const emptySection = harness.renderer.root.find(
      (node) => typeof node.type === 'string' && node.props['data-host-id'] === PEER_A_HOST_ID,
    );
    const unknownSection = harness.renderer.root.find(
      (node) => typeof node.type === 'string' && node.props['data-host-id'] === PEER_B_HOST_ID,
    );
    assert.equal(emptySection.props['data-host-emptiness'], 'empty');
    assert.equal(unknownSection.props['data-host-emptiness'], 'unknown');
    assert.equal(remoteRows(harness, PEER_A_HOST_ID).length, 0);
    const text = visibleText(harness);
    assert.match(text, /No sessions on studio/i);
    assert.match(text, /cannot report its sessions/i);
  } finally {
    await harness.dispose();
  }
});

test('Given a pending local action, when a peer fails and recovers, then the local group is never reset', async () => {
  let localRenders = 0;
  function LocalSections() {
    localRenders += 1;
    return createElement('div', { 'data-local-sections': 'true' });
  }
  const harness = await mountHostGroups({
    roster: () => jsonResponse(rosterBody()),
    children: createElement(LocalSections),
  });

  try {
    await harness.emit(snapshotFrame(PEER_A_HOST_ID, 1, {
      sessions: [sessionRow('gjc-session', 'refactor the parser')],
    }) as ServerEvent);
    const rendersAfterMount = localRenders;

    await harness.emit({
      kind: 'fleet.host_state',
      host: peerDescriptor(PEER_A_HOST_ID, 'studio', 'offline'),
    } as ServerEvent);
    await harness.emit({
      kind: 'fleet.host_state',
      host: peerDescriptor(PEER_A_HOST_ID, 'studio', 'online'),
    } as ServerEvent);
    await harness.emit(snapshotFrame(PEER_A_HOST_ID, 2, {
      sessions: [sessionRow('gjc-session', 'refactor the parser')],
    }) as ServerEvent);

    assert.equal(
      localRenders,
      rendersAfterMount,
      'peer state churn must not re-render or remount the local sections, which hold the pending destructive target',
    );
    assert.deepEqual(groupHostIds(harness), [LOCAL_HOST_ID, PEER_A_HOST_ID, PEER_B_HOST_ID]);
  } finally {
    await harness.dispose();
  }
});

test('Given a fresh remote pane, when its row is activated, then the exact host and process generation open in the terminal', async () => {
  const harness = await mountHostGroups({ roster: () => jsonResponse(rosterBody()) });

  try {
    const pane = { ...paneRow('/tmp/peer-a.sock', 'agent'), kind: 'codex', lane: 'external' as const };
    await harness.emit(snapshotFrame(PEER_A_HOST_ID, 1, { panes: [pane] }) as ServerEvent);
    const [row] = remoteRows(harness, PEER_A_HOST_ID);
    assert.ok(row);
    await act(async () => row.onClick?.());

    assert.deepEqual(harness.openedTerminals, [{
      hostId: PEER_A_HOST_ID,
      hostLabel: 'studio',
      localId: pane.localId,
      lane: pane.lane,
      tmuxName: pane.tmuxName,
      tmux: pane.tmux,
      process: pane.process,
      kind: pane.kind,
      cliKind: 'codex',
      project: null,
    }]);
  } finally {
    await harness.dispose();
  }
});

test('Given the local group, when it renders, then it is labelled as this machine and keeps its own counts', async () => {
  const harness = await mountHostGroups({ roster: () => jsonResponse(rosterBody()) });

  try {
    const localSection = harness.renderer.root.find(
      (node) => typeof node.type === 'string' && node.props['data-host-id'] === LOCAL_HOST_ID,
    );
    assert.equal(localSection.props['data-host-local'], 'true');
    assert.match(visibleText(harness), /This machine/i);
    assert.equal(remoteRows(harness, LOCAL_HOST_ID).length, 0, 'the local group renders the existing sections');
  } finally {
    await harness.dispose();
  }
});
