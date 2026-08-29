import assert from 'node:assert/strict';
import test from 'node:test';

import { createElement } from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';

import { tmuxPaneIdentityKey } from '../../../../shared/tmux';
import { api } from '../../../utils/api';
import type { ExternalCliSession } from '../../sidebar/hooks/useExternalCliSessions';

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
