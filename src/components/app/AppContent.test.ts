import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import type { ExternalTerminalTarget } from '../../types/app';
import type { ExternalCliSession } from '../sidebar/hooks/useExternalCliSessions';

import { refreshExternalTerminalAttachCapability, resolveExternalTerminalRoute } from './AppContent';

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

test('B8: forceAttach always routes an indexed local-agent pane to terminal, not transcript', () => {
  const indexedLocalAgent: ExternalTerminalTarget = {
    tmuxName: 'claude-review',
    tmux: { ...tmux, paneId: '%9' },
    process: { pid: 42, startedAtMs: 1_700_000_000_000 },
    kind: 'Claude Code',
    cliKind: 'claude',
    project: { projectId: 'project-1', displayName: 'Project', fullPath: '/workspace/project' },
    transcriptSessionId: 'session-indexed',
    forceAttach: true,
  };
  assert.equal(resolveExternalTerminalRoute(indexedLocalAgent), 'terminal');
  // Without forceAttach the same indexed session still routes to transcript —
  // forceAttach is the only thing that changes the decision.
  assert.equal(resolveExternalTerminalRoute({ ...indexedLocalAgent, forceAttach: undefined }), 'transcript');
});

test('B8: attach routing is keyed on the exact pane 4-tuple, not the tmux name alone', () => {
  const badgePane: ExternalTerminalTarget = {
    tmuxName: 'claude-review',
    tmux: { socketPath: '/tmp/tmux-1000/default', sessionId: 'work', windowId: '@1', paneId: '%9' },
    process: { pid: 42, startedAtMs: 1_700_000_000_000 },
    kind: 'Claude Code',
    cliKind: 'claude',
    project: { projectId: 'project-1', displayName: 'Project', fullPath: '/workspace/project' },
    transcriptSessionId: 'session-indexed',
    forceAttach: true,
  };
  const otherPaneSameName: ExternalTerminalTarget = {
    ...badgePane,
    tmux: { ...badgePane.tmux, paneId: '%99' },
  };
  // Both route to terminal (forceAttach) — the AC-critical fact is that the
  // attach target callers build from these carries the exact tmux identity
  // through unchanged, so a badge click on one pane can never resolve to
  // another pane's coordinates.
  assert.equal(resolveExternalTerminalRoute(badgePane), 'terminal');
  assert.equal(resolveExternalTerminalRoute(otherPaneSameName), 'terminal');
  assert.notDeepEqual(badgePane.tmux, otherPaneSameName.tmux);
});

test('B8: gjc and attach-only kinds always route to terminal regardless of forceAttach', () => {
  const gjcTarget: ExternalTerminalTarget = {
    tmuxName: 'agent',
    tmux: { ...tmux, paneId: '%5' },
    process: null,
    kind: 'GJC',
    cliKind: 'gjc',
    project: { projectId: 'project-1', displayName: 'Project', fullPath: '/workspace/project' },
  };
  assert.equal(resolveExternalTerminalRoute(gjcTarget), 'terminal');
  assert.equal(resolveExternalTerminalRoute(target), 'terminal');
});

test('capability refresh consumes the discovery roster without adding its own request', () => {
  const hook = readFileSync(new URL('../sidebar/hooks/useExternalCliSessions.ts', import.meta.url), 'utf8');
  const appContent = readFileSync(new URL('./AppContent.tsx', import.meta.url), 'utf8');
  const refreshCallback = appContent.slice(
    appContent.indexOf('const refreshExternalTerminalCapability'),
    appContent.indexOf('const openExternalTerminal'),
  );

  // B15 replaced the unconditional 5s roster poll with the discovery stream.
  // Two REST call sites remain by design: a non-cancellable hydration that
  // seeds transcript/model/capability metadata the stream does not carry, and
  // a bounded fallback that only runs while the stream is unhealthy. Neither
  // belongs to the capability refresh, which reads the roster the sidebar
  // already publishes.
  assert.equal((hook.match(/api\.externalSessions\(\)/g) ?? []).length, 2);
  assert.match(hook, /if \(streamHealthy\) return undefined;/);
  assert.match(hook, /onSessionsChangeRef\.current\?\.\(/);
  assert.doesNotMatch(refreshCallback, /api\.externalSessions/);
});
