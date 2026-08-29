import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import type { ExternalTerminalTarget } from '../../types/app';
import type { ExternalCliSession } from '../sidebar/hooks/useExternalCliSessions';

import {
  isSameExternalTerminal,
  refreshExternalTerminalAttachCapability,
  resolveExternalTerminalRoute,
} from './AppContent';

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

test('hub-local discovery leaves a remote terminal under its owning host authority', () => {
  const remote = { ...target, hostId: '11111111-1111-4111-8111-111111111111' };
  assert.equal(refreshExternalTerminalAttachCapability(remote, []), remote);
  assert.equal(isSameExternalTerminal(remote, { ...remote, hostId: '22222222-2222-4222-8222-222222222222' }), false);
});

test('invalidates a selected terminal when the authoritative roster lacks its exact pane', () => {
  const refreshed = refreshExternalTerminalAttachCapability(target, [{
    ...session,
    tmux: { ...tmux, paneId: '%3' },
  }]);

  assert.equal(refreshed, null);
});

test('invalidates a selected terminal when its exact row is stale or unavailable', () => {
  assert.equal(refreshExternalTerminalAttachCapability(target, [{
    ...session,
    presence: 'stale',
    authority: 'stream',
  }]), null);
  assert.equal(refreshExternalTerminalAttachCapability(target, [{
    ...session,
    presence: 'present',
    authority: 'none',
  }]), null);
});

test('local-agent capability refresh never rebinds a replacement process generation', () => {
  const localTarget = {
    ...target,
    process: { pid: 42, startedAtMs: 1_700_000_000_000 },
    kind: 'Claude Code',
    cliKind: 'claude',
    attachCapability: undefined,
  } satisfies ExternalTerminalTarget;
  const exactSession = {
    ...session,
    process: localTarget.process,
    kind: 'claude',
    transcriptSessionId: 'session-ready',
  } satisfies ExternalCliSession;

  assert.equal(
    refreshExternalTerminalAttachCapability(localTarget, [{
      ...exactSession,
      process: { ...localTarget.process, pid: 43 },
    }]),
    null,
  );
  const refreshed = refreshExternalTerminalAttachCapability(localTarget, [exactSession]);
  assert.ok(refreshed && 'transcriptSessionId' in refreshed);
  assert.equal(refreshed.transcriptSessionId, 'session-ready');
});

test('terminal request fencing distinguishes replacement process generations in one pane', () => {
  const selected = {
    ...target,
    process: { pid: 42, startedAtMs: 1_700_000_000_000 },
    kind: 'Claude Code',
    cliKind: 'claude',
    attachCapability: undefined,
  } satisfies ExternalTerminalTarget;

  assert.equal(isSameExternalTerminal(selected, selected), true);
  assert.equal(isSameExternalTerminal({
    ...selected,
    process: { ...selected.process!, pid: 43 },
  }, selected), false);
  assert.equal(isSameExternalTerminal({
    ...selected,
    process: { ...selected.process!, startedAtMs: selected.process!.startedAtMs + 1 },
  }, selected), false);
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

test('indexed external sessions require an exact Project for transcript navigation', () => {
  const indexedWithoutProject: ExternalTerminalTarget = {
    tmuxName: 'claude-review',
    tmux: { ...tmux, paneId: '%10' },
    process: { pid: 43, startedAtMs: 1_700_000_000_001 },
    kind: 'Claude Code',
    cliKind: 'claude',
    project: null,
    projectPath: '/workspace/unregistered',
    transcriptSessionId: 'session-indexed',
  };

  assert.equal(resolveExternalTerminalRoute(indexedWithoutProject), 'terminal');
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

test('standalone chrome keeps app UI below a separate opaque safe-area surface', () => {
  const appContent = readFileSync(new URL('./AppContent.tsx', import.meta.url), 'utf8');
  const styles = readFileSync(new URL('../../index.css', import.meta.url), 'utf8');
  const documentHtml = readFileSync(new URL('../../../index.html', import.meta.url), 'utf8');
  const themeContext = readFileSync(new URL('../../contexts/ThemeContext.jsx', import.meta.url), 'utf8');
  const opaqueChromeSources = [
    '../main-content/view/subcomponents/MainContentStateView.tsx',
    '../sidebar/view/subcomponents/SidebarContent.tsx',
    '../sidebar/view/subcomponents/SidebarCollapsed.tsx',
  ].map((source) => readFileSync(new URL(source, import.meta.url), 'utf8'));

  assert.match(appContent, /className="pwa-status-bar-surface"/);
  assert.match(appContent, /className="app-shell fixed inset-0 flex bg-background"/);
  assert.match(styles, /\.pwa-status-bar-surface\s*\{/);
  assert.match(styles, /background: hsl\(var\(--background\)\)/);
  assert.doesNotMatch(styles, /\.pwa-status-bar-surface[\s\S]{0,400}backdrop-filter/);
  assert.match(documentHtml, /apple-mobile-web-app-status-bar-style" content="black"/);
  assert.doesNotMatch(documentHtml, /black-translucent/);
  assert.doesNotMatch(themeContext, /black-translucent/);
  assert.match(styles, /body \.app-shell,[\s\S]*top: var\(--safe-area-inset-top\) !important/);
  assert.match(styles, /left: var\(--safe-area-inset-left\) !important/);
  assert.match(styles, /right: var\(--safe-area-inset-right\) !important/);
  assert.match(styles, /\.fixed\.inset-0:not\(\.app-shell\)/);
  assert.doesNotMatch(styles, /body\.pwa-mode \.fixed\.inset-0\s*\{/);
  assert.doesNotMatch(styles, /\.pwa-header-safe[\s\S]{0,160}padding-top: 0/);
  for (const source of opaqueChromeSources) {
    assert.doesNotMatch(source, /backdrop-blur/);
    assert.match(source, /bg-background/);
  }
});
