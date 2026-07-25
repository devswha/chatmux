import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import type { ExternalTerminalTarget } from '../../types/app';
import type { ExternalCliSession } from '../sidebar/hooks/useExternalCliSessions';

import { refreshExternalTerminalAttachCapability } from './AppContent';

const tmux = {
  socketPath: '/tmp/tmux-1000/default',
  sessionId: 'work',
  windowId: '@1',
  paneId: '%2',
};

const target: ExternalTerminalTarget = {
  tmuxName: 'work',
  tmux,
  process: null,
  kind: 'ssh',
  cliKind: 'ssh',
  project: { projectId: 'project-1', displayName: 'Project', fullPath: '/workspace/project' },
  attachCapability: 'stale-capability',
};

const session: ExternalCliSession = {
  tmuxName: 'work',
  tmux,
  process: null,
  kind: 'ssh',
  attachCapability: 'fresh-capability',
};

test('refreshes the selected terminal capability from its exact pane row', () => {
  const refreshed = refreshExternalTerminalAttachCapability(target, [session]);

  assert.notEqual(refreshed, target);
  assert.equal('attachCapability' in (refreshed ?? {}), true);
  assert.equal(refreshed && 'attachCapability' in refreshed ? refreshed.attachCapability : undefined, 'fresh-capability');
});

test('does not refresh a selected terminal from a different pane', () => {
  const refreshed = refreshExternalTerminalAttachCapability(target, [{
    ...session,
    tmux: { ...tmux, paneId: '%3' },
  }]);

  assert.equal(refreshed, target);
  assert.equal(refreshed && 'attachCapability' in refreshed ? refreshed.attachCapability : undefined, 'stale-capability');
});

test('capability refresh consumes the sidebar poll without adding a request or interval', () => {
  const hook = readFileSync(new URL('../sidebar/hooks/useExternalCliSessions.ts', import.meta.url), 'utf8');
  const appContent = readFileSync(new URL('./AppContent.tsx', import.meta.url), 'utf8');
  const refreshCallback = appContent.slice(
    appContent.indexOf('const refreshExternalTerminalCapability'),
    appContent.indexOf('const openExternalTerminal'),
  );

  assert.equal((hook.match(/api\.externalSessions\(\)/g) ?? []).length, 1);
  assert.equal((hook.match(/setInterval\(poll, POLL_INTERVAL_MS\)/g) ?? []).length, 1);
  assert.match(hook, /onSessionsChangeRef\.current\?\.\(sessions\)/);
  assert.doesNotMatch(refreshCallback, /api\.externalSessions/);
});
