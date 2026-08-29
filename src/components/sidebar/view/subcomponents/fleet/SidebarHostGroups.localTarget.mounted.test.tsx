import assert from 'node:assert/strict';
import test from 'node:test';

import { createElement } from 'react';
import { act } from 'react-test-renderer';

import type { ServerEvent } from '../../../../../contexts/WebSocketContext';
import {
  PEER_A_HOST_ID,
  peerDescriptor,
  sessionRow,
  snapshotFrame,
} from '../../../../../fleet/discovery/hostCatalog.testSupport';
import type { Project, ProjectSession } from '../../../../../types/app';
import { CompletionNotificationsContext } from '../../../context/CompletionNotificationsContext';
import SidebarLiveSection from '../SidebarLiveSection';

import { jsonResponse, mountHostGroups, remoteRows, rosterBody, visibleText } from './hostGroups.testSupport';

const noop = () => {};
const gjcTarget = {
  tmux: { socketPath: '/tmp/local.sock', sessionId: '$1', windowId: '@1', paneId: '%1' },
  process: { pid: 4141, startedAtMs: 1_700_000_000_000 },
};

/** The real local live section, with one closable GJC row. */
function localSections() {
  const props: React.ComponentProps<typeof SidebarLiveSection> = {
    projects: [{
      projectId: 'project-local',
      displayName: 'omg',
      sessions: [{ id: 'local-session', summary: 'local work', provider: 'gjc' }],
    }] as unknown as Project[],
    liveSessionIds: new Set(['local-session']),
    liveSessionNames: new Map([['local-session', 'omg']]),
    liveSessionLineage: new Set(['local-session']),
    liveSessionPanes: new Map([['local-session', gjcTarget.tmux]]),
    liveSessionPresence: new Map([['local-session', 'present' as const]]),
    liveSessionTargets: new Map([['local-session', gjcTarget]]),
    liveSessionKinds: new Map([['local-session', 'interactive']]),
    liveSessionRunning: new Set<string>(),
    selectedSession: null,
    onProjectSelect: noop as unknown as (project: Project) => void,
    onSessionSelect: noop as unknown as (session: ProjectSession, projectId: string) => void,
  };
  return createElement(
    CompletionNotificationsContext.Provider,
    {
      value: {
        status: null,
        statuses: new Map(),
        registerDescriptors: () => () => {},
        setWatch: async () => {},
        repairDevice: async () => {},
        refresh: async () => {},
      } as never,
    },
    createElement(SidebarLiveSection, props),
  );
}

function installStorage() {
  const values = new Map<string, string>();
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
      clear: () => values.clear(),
      key: () => null,
      get length() { return values.size; },
    },
  });
  return () => {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  };
}

test('Given a pending local kill confirmation, when a peer fails and recovers, then the local target is untouched', async () => {
  const restoreStorage = installStorage();
  const harness = await mountHostGroups({
    roster: () => jsonResponse(rosterBody()),
    children: localSections(),
  });

  try {
    await harness.emit(snapshotFrame(PEER_A_HOST_ID, 1, {
      sessions: [sessionRow('gjc-session', 'remote work')],
    }) as ServerEvent);

    const closeButton = harness.renderer.root.find((node) => (
      node.type === 'button' && node.props['aria-label'] === "Close tmux session 'omg'"
    ));
    assert.doesNotMatch(
      visibleText(harness),
      /All panes and processes in 'omg' will stop\./,
      'the confirmation is not on screen until it is requested',
    );
    await act(async () => { closeButton.props.onClick(); });
    assert.match(
      visibleText(harness),
      /All panes and processes in 'omg' will stop\./,
      'the local destructive confirmation is open',
    );

    await harness.emit({
      kind: 'fleet.host_state',
      host: peerDescriptor(PEER_A_HOST_ID, 'studio', 'offline'),
    } as ServerEvent);
    assert.equal(remoteRows(harness, PEER_A_HOST_ID)[0]?.disabled, true);
    assert.match(
      visibleText(harness),
      /All panes and processes in 'omg' will stop\./,
      'a peer going offline cannot discard the local confirmation',
    );

    await harness.emit({
      kind: 'fleet.host_state',
      host: peerDescriptor(PEER_A_HOST_ID, 'studio', 'online'),
    } as ServerEvent);
    await harness.emit(snapshotFrame(PEER_A_HOST_ID, 2, {
      sessions: [sessionRow('gjc-session', 'remote work'), sessionRow('second', 'more remote work')],
    }) as ServerEvent);

    assert.equal(remoteRows(harness, PEER_A_HOST_ID).length, 2, 'only the recovered peer group changed');
    assert.equal(remoteRows(harness, PEER_A_HOST_ID)[0]?.disabled, false);
    const text = visibleText(harness);
    assert.match(text, /All panes and processes in 'omg' will stop\./, 'the local confirmation survived the recovery');
    assert.match(text, /Close/, 'its confirm control is still offered');
  } finally {
    await harness.dispose();
    restoreStorage();
  }
});
