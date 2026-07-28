import assert from 'node:assert/strict';
import test from 'node:test';

import i18next from 'i18next';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';

import type { CompletionNotificationDevice } from '../../../../../shared/completion-notifications';
import { CompletionNotificationsContext, completionNotificationDescriptorKey } from '../../context/CompletionNotificationsContext';

import SidebarExternalSection from './SidebarExternalSection';
import SidebarLiveSection from './SidebarLiveSection';

const device: CompletionNotificationDevice = { supported: true, registered: true, setupRequired: false, reason: null };
const project = { projectId: 'project-1', name: 'Project', displayName: 'Project', path: '/project', fullPath: '/project', sessions: [] };
const disableCompletionLabel = 'Disable completion notifications for this session';
const completionStatus = (provider: string, sessionId: string, watched = true) => [
  completionNotificationDescriptorKey({ kind: 'app' as const, provider, sessionId }),
  {
    item: { alias: 'owner', mappingState: 'one_active' as const, reason: 'eligible' as const, target: { alias: 'owner', kind: 'app' as const, revision: 1, watched } },
    target: { alias: 'owner', kind: 'app' as const, revision: 1, watched },
    pending: false,
    error: null,
    globalPaused: false,
    device,
  },
] as const;

async function renderWithCompletion(node: ReturnType<typeof createElement>, statuses: readonly (readonly [string, unknown])[]) {
  const i18n = i18next.createInstance();
  await i18n.init({
    lng: 'en',
    resources: {
      en: {
        sidebar: {
          completionNotifications: { disable: disableCompletionLabel },
        },
      },
    },
    ns: ['sidebar'],
    defaultNS: 'sidebar',
  });
  const value = {
    status: null,
    statuses: new Map(statuses),
    registerDescriptors: () => () => {},
    setWatch: async () => {},
    repairDevice: async () => {},
    refresh: async () => {},
  };
  return renderToStaticMarkup(createElement(I18nextProvider, { i18n }, createElement(
    CompletionNotificationsContext.Provider,
    { value: value as never },
    node,
  )));
}


test('live GJC rows place their bell immediately left of the lineage-authorized stop control', async () => {
  const liveProject = {
    ...project,
    sessions: [{ id: 'session-1', summary: 'A session', provider: 'gjc' }],
  };
  const html = await renderWithCompletion(
    createElement(SidebarLiveSection, {
      projects: [liveProject],
      liveSessionIds: new Set(['session-1']),
      liveSessionNames: new Map([['session-1', 'live-pane']]),
      liveSessionLineage: new Set(['session-1']),
      liveSessionTargets: new Map([['session-1', {
        tmux: { socketPath: '/tmp/tmux', sessionId: 's', windowId: '@1', paneId: '%1' },
        process: { pid: 10, startedAtMs: 1 },
      }]]),
      liveSessionKinds: new Map([['session-1', 'interactive']]),
      liveSessionRunning: new Set<string>(),
      selectedSession: null,
      onProjectSelect: () => {},
      onSessionSelect: () => {},
    } as never),
    [completionStatus('gjc', 'session-1')],
  );
  const bell = html.indexOf(`aria-label="${disableCompletionLabel}"`);
  const bellButtonEnd = html.indexOf('</button>', bell);
  const bellContainerEnd = html.indexOf('</span>', bellButtonEnd);
  const stop = html.indexOf('title="liveSessions.stopOptions"');

  assert.ok(bell >= 0, 'the eligible live GJC row renders a bell');
  const nextButton = html.indexOf('<button', bellContainerEnd);
  assert.equal(nextButton, bellContainerEnd + '</span>'.length, 'the stop control immediately follows the bell');
  assert.ok(stop > nextButton && stop < html.indexOf('</button>', nextButton), 'the following control is the stop button');
});

test('external agent rows place their bell immediately left of the stop X and omit attach-only providers', async () => {
  const external = {
    kind: 'claude',
    tmuxName: 'agent',
    tmux: { socketPath: '/tmp/tmux', sessionId: 's', windowId: '@1', paneId: '%1' },
    process: { pid: 10, startedAtMs: 1 },
    projectPath: '/project',
    activity: 'running',
  };
  const externalKey = completionNotificationDescriptorKey({ kind: 'external_generation', session: { kind: 'claude', tmux: external.tmux, agentPid: 10, startedAtMs: 1 } });
  const externalStatus = {
    item: {
      alias: 'external-generation',
      mappingState: 'none' as const,
      reason: 'eligible' as const,
      target: { alias: 'external-generation', kind: 'external_generation' as const, revision: 1, watched: true },
    },
    target: { alias: 'external-generation', kind: 'external_generation' as const, revision: 1, watched: true },
    pending: false,
    error: null,
    globalPaused: false,
    device,
  };
  const html = await renderWithCompletion(
    createElement(SidebarExternalSection, { sessions: [external], projects: [project], onOpen: () => {}, onChanged: () => {} } as never),
    [[externalKey, externalStatus]],
  );
  const externalBell = html.indexOf('aria-label="Disable completion notifications for this session"');
  const externalBellButtonEnd = html.indexOf('</button>', externalBell);
  const externalBellContainerEnd = html.indexOf('</span>', externalBellButtonEnd);
  const externalStop = html.indexOf('title="externalSessions.stopOptions"');
  assert.ok(externalBell >= 0, 'the eligible external agent row renders a bell');
  const externalNextButton = html.indexOf('<button', externalBellContainerEnd);
  assert.equal(
    externalNextButton,
    externalBellContainerEnd + '</span>'.length,
    'the external stop control immediately follows the bell',
  );
  assert.ok(
    externalStop > externalNextButton && externalStop < html.indexOf('</button>', externalNextButton),
    'the following external control is the stop button',
  );

  const shell = await renderWithCompletion(
    createElement(SidebarExternalSection, { sessions: [{ ...external, kind: 'shell', process: null }], projects: [project], onOpen: () => {}, onChanged: () => {} } as never),
    [],
  );
  assert.doesNotMatch(shell, /completion notifications for this session/);
});

test('external completion bells follow the documented provider allowlist', async () => {
  for (const kind of ['claude', 'codex', 'opencode', 'omp'] as const) {
    const external = {
      kind,
      tmuxName: `${kind}-agent`,
      tmux: { socketPath: '/tmp/tmux', sessionId: 's', windowId: '@1', paneId: `%${kind.length}` },
      process: { pid: 100 + kind.length, startedAtMs: 1 },
      projectPath: '/project',
      activity: 'running',
    };
    const key = completionNotificationDescriptorKey({
      kind: 'external_generation',
      session: {
        kind,
        tmux: external.tmux,
        agentPid: external.process.pid,
        startedAtMs: external.process.startedAtMs,
      },
    });
    const html = await renderWithCompletion(
      createElement(
        SidebarExternalSection,
        { sessions: [external], projects: [project], onOpen: () => {}, onChanged: () => {} } as never,
      ),
      [[key, completionStatus('unused', 'unused')[1]]],
    );
    assert.match(html, /completion notifications for this session/i, `${kind} renders a completion bell`);
  }

  const cursor = {
    kind: 'cursor',
    tmuxName: 'cursor-agent',
    tmux: { socketPath: '/tmp/tmux', sessionId: 's', windowId: '@1', paneId: '%9' },
    process: { pid: 109, startedAtMs: 1 },
    projectPath: '/project',
    activity: 'running',
  };
  const cursorHtml = await renderWithCompletion(
    createElement(
      SidebarExternalSection,
      { sessions: [cursor], projects: [project], onOpen: () => {}, onChanged: () => {} } as never,
    ),
    [],
  );
  assert.doesNotMatch(cursorHtml, /completion notifications for this session/i);
});
