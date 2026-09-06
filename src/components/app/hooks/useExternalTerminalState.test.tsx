import assert from 'node:assert/strict';
import test from 'node:test';

import { createElement } from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter } from 'react-router-dom';

import { tmuxPaneIdentityKey } from '../../../../shared/tmux';
import { api } from '../../../utils/api';
import type { ExternalCliSession } from '../../sidebar/hooks/useExternalCliSessions';
import { sessionRef } from '../../../fleet/references';
import type { ExternalTerminalTarget } from '../../../types/app';
import { FleetHostCatalogContext } from '../../../fleet/discovery/FleetHostCatalogContext';
import { peerDescriptor } from '../../../fleet/discovery/hostCatalog.testSupport';
import type { FleetHostCatalog } from '../../../fleet/discovery/hostCatalog';
import SidebarHostGroups from '../../sidebar/view/subcomponents/fleet/SidebarHostGroups';
import { sidebarI18n } from '../../sidebar/view/subcomponents/fleet/hostGroups.testSupport';

import { useExternalTerminalState } from './useExternalTerminalState';

const session = {
  tmuxName: 'work',
  tmux: {
    socketPath: '/tmp/tmux-1000/default',
    sessionId: 'work',
    windowId: '@1',
    paneId: '%2',
  },
  process: null,
  kind: 'ssh',
  activity: 'running',
  attachCapability: 'fresh-capability',
} satisfies ExternalCliSession;

test('selecting a peer transcript drops both terminal and transcript takeover before navigating', async () => {
  const target: ExternalTerminalTarget = { ...session, cliKind: 'ssh', project: null };
  const reference = sessionRef('22222222-2222-4222-8222-222222222222', 'same-session');
  const selected: unknown[] = [];
  const i18n = await sidebarI18n();
  const catalog: FleetHostCatalog = { localHostId: '11111111-1111-4111-8111-111111111111', hosts: new Map([
    [reference.hostId, { descriptor: peerDescriptor(reference.hostId, 'Peer'), sync: 'synced', epoch: 'fixture', revision: 1, truncated: false,
      rows: { projects: [], panes: [], sessions: [{ localId: reference.localId, projectLocalId: 'project', provider: 'codex', summary: 'Transcript', lastActivityMs: 1 }] } }],
  ]) };
  let state!: ReturnType<typeof useExternalTerminalState>;
  function Probe() {
    state = useExternalTerminalState({
      setActiveTab: () => {}, setSidebarOpen: () => {}, onProjectSelect: () => {}, onSessionSelect: () => {},
      onRemoteSessionSelect: (next) => selected.push(next), projects: [], subscribe: () => () => {},
    });
    return <SidebarHostGroups
      local={{ rowLabels: [], counts: { projects: 0, sessions: 0, panes: 0 } }}
      onRemotePaneOpen={() => {}}
      onRemoteSessionOpen={(next) => state.openRemoteSession(next)}
    >{null}</SidebarHostGroups>;
  }
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(createElement(MemoryRouter, { initialEntries: [`/hosts/${reference.hostId}/session/${reference.localId}`] },
    createElement(I18nextProvider, { i18n }, createElement(FleetHostCatalogContext.Provider,
      { value: { catalog, hasRemoteHosts: true, refresh: () => {} } }, createElement(Probe))))); });
  try {
    await act(async () => { state.setExternalTerminal(target); state.setExternalTranscript(target); });
    assert.ok(state.externalTerminal);
    await act(async () => {
      renderer.root.findAllByType('button').find((node) => node.props['data-host-row-kind'] === 'session')!.props.onClick();
    });
    assert.equal(state.externalTerminal, null);
    assert.equal(state.externalTranscript, null);
    assert.deepEqual(selected, [reference]);
  } finally { await act(async () => { renderer.unmount(); }); }
});

test('does not request a fallback when the published external roster refreshes mounted state', async () => {
  // Given a mounted controller whose REST seam records every fallback request.
  const originalExternalSessions = api.externalSessions;
  let requestCount = 0;
  api.externalSessions = async () => {
    requestCount += 1;
    return new Response(null, { status: 200 });
  };

  const states: ReturnType<typeof useExternalTerminalState>[] = [];
  let renderer: ReactTestRenderer | null = null;
  function Probe() {
    states.push(useExternalTerminalState({
      setActiveTab: () => undefined,
      setSidebarOpen: () => undefined,
      onProjectSelect: () => undefined,
      onSessionSelect: () => undefined,
      projects: [],
      subscribe: () => () => undefined,
    }));
    return null;
  }

  try {
    await act(async () => {
      renderer = TestRenderer.create(createElement(Probe));
    });
    const mountedState = states.at(-1);
    assert.ok(mountedState);

    // When the sidebar publishes its authoritative roster to the controller.
    await act(async () => {
      mountedState.refreshExternalTerminalCapability([session]);
    });
    const refreshedState = states.at(-1);
    assert.ok(refreshedState);

    // Then the roster is consumed locally without a duplicate REST request.
    assert.deepEqual([...refreshedState.externalRunningPanes], [tmuxPaneIdentityKey(session.tmux)]);
    assert.equal(requestCount, 0);
  } finally {
    if (renderer) await act(async () => renderer?.unmount());
    api.externalSessions = originalExternalSessions;
  }
});
