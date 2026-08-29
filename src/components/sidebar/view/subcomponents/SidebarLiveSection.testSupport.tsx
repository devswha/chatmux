/**
 * Shared harness for the SidebarLiveSection test files: ko-locale SSR renderer,
 * project fixtures, and the GJC/external handoff prop builder. Split from the
 * former `SidebarLiveSection.test.tsx`.
 */


import i18next from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import koSidebar from '../../../../i18n/locales/ko/sidebar.json';
import type { Project, ProjectSession } from '../../../../types/app';
import type { TmuxPaneTarget } from '../../../../../shared/tmux';
import {
  CompletionNotificationsContext,
  completionNotificationDescriptorKey,
} from '../../context/CompletionNotificationsContext';

import SidebarLiveSection from './SidebarLiveSection';

export const target = (paneId: string, pid: number): TmuxPaneTarget => ({
  tmux: { socketPath: '/tmp/chatmux.sock', sessionId: 'session-1', windowId: '@1', paneId },
  process: { pid, startedAtMs: 1_700_000_000_000 + pid },
});


export const noop = () => {};
export const onSessionSelect = noop as unknown as (session: ProjectSession, projectName: string) => void;
export const onProjectSelect = noop as unknown as (project: Project) => void;

// The section's strings are ko-authored i18n resources; rendering with the ko
// locale keeps these SSR assertions pinned to the shipped translations.
export const completionStatus = (sessionId: string, watched = true) => [
  completionNotificationDescriptorKey({ kind: 'app' as const, provider: 'gjc', sessionId }),
  {
    item: { alias: 'owner', mappingState: 'one_active' as const, reason: 'eligible' as const, target: { alias: 'owner', kind: 'app' as const, revision: 1, watched } },
    target: { alias: 'owner', kind: 'app' as const, revision: 1, watched },
    pending: false,
    error: null,
    globalPaused: false,
    device: { supported: true, registered: true, setupRequired: false, reason: null },
  },
] as const;

export const renderSection = async (
  props: React.ComponentProps<typeof SidebarLiveSection>,
  statuses: readonly (readonly [string, unknown])[] = [],
) => {
  const instance = i18next.createInstance();
  await instance.init({
    lng: 'ko',
    fallbackLng: false,
    resources: { ko: { sidebar: koSidebar } },
    ns: ['sidebar'],
    defaultNS: 'sidebar',
    interpolation: { escapeValue: false },
  });
  return renderToStaticMarkup(
    createElement(
      I18nextProvider,
      { i18n: instance },
      createElement(
        CompletionNotificationsContext.Provider,
        {
          value: {
            status: null,
            statuses: new Map(statuses),
            registerDescriptors: () => () => {},
            setWatch: async () => {},
            repairDevice: async () => {},
            refresh: async () => {},
          } as never,
        },
        createElement(SidebarLiveSection, props),
      ),
    ),
  );
};

export function makeProjects(): Project[] {
  return [
    {
      projectId: 'p1',
      displayName: 'Proj One',
      sessions: [
        { id: 's-live', summary: 'Live conversation title', provider: 'gjc' },
        { id: 's-idle', summary: 'Idle conversation', provider: 'gjc' },
      ],
    },
  ] as unknown as Project[];
}

export const handoffProps = ({
  gjcPresence = 'present',
  gjcTarget,
  externalTarget,
  externalPresence = 'present',
  externalAuthority = 'stream',
}: {
  gjcPresence?: 'present' | 'stale';
  gjcTarget: TmuxPaneTarget;
  externalTarget: TmuxPaneTarget;
  externalPresence?: 'present' | 'stale';
  externalAuthority?: 'stream' | 'rest' | 'none';
}): React.ComponentProps<typeof SidebarLiveSection> => ({
  projects: makeProjects(),
  liveSessionIds: new Set(['s-live']),
  externalSessions: [{
    tmuxName: 'external-row',
    tmux: externalTarget.tmux,
    process: externalTarget.process,
    kind: 'claude',
    presence: externalPresence,
    authority: externalAuthority,
  }],
  liveSessionNames: new Map([['s-live', 'gjc-row']]),
  liveSessionLineage: new Set(['s-live']),
  liveSessionPanes: new Map([['s-live', gjcTarget.tmux]]),
  liveSessionPresence: new Map([['s-live', gjcPresence]]),
  liveSessionTargets: new Map([['s-live', gjcTarget]]),
  liveSessionKinds: new Map([['s-live', 'interactive']]),
  liveSessionRunning: new Set<string>(),
  selectedSession: null,
  onProjectSelect,
  onSessionSelect,
  onExternalTerminalOpen: noop,
});

