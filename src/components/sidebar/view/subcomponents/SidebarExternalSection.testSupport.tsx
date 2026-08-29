/**
 * Shared harness for the SidebarExternalSection test files: locale renderer and
 * tmux/project fixtures. Split from the former `SidebarExternalSection.test.tsx`.
 */


import i18next from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import enSidebar from '../../../../i18n/locales/en/sidebar.json';
import koSidebar from '../../../../i18n/locales/ko/sidebar.json';
import type { ExternalTerminalTarget, Project } from '../../../../types/app';
import type { TmuxPaneIdentity, TmuxProcessGeneration } from '../../../../../shared/tmux';
import { CompletionNotificationsProvider } from '../../context/CompletionNotificationsContext';

import SidebarExternalSection from './SidebarExternalSection';


export const tmux = (paneId: string): TmuxPaneIdentity => ({
  socketPath: '/tmp/chatmux.sock',
  sessionId: 'session-1',
  windowId: '@1',
  paneId,
});
export const process = (pid: number): TmuxProcessGeneration => ({ pid, startedAtMs: 1_700_000_000_000 + pid });
export const external = (
  tmuxName: string,
  kind: 'claude' | 'codex' | 'cursor' | 'opencode' | 'omp' | 'ssh' | 'shell',
  paneId: string,
  pid: number | null,
  extra: Record<string, unknown> = {},
) => ({
  tmuxName, tmux: tmux(paneId), process: pid === null ? null : process(pid), kind, ...extra,
});
export const project = {
  projectId: 'project-1',
  displayName: 'ChatMux',
  fullPath: '/workspace/chatmux',
} satisfies Project;

export const otherProject = {
  projectId: 'project-2',
  displayName: 'Other',
  fullPath: '/workspace/other',
} satisfies Project;

export const noop = () => {};
export const onOpen = noop as unknown as (target: ExternalTerminalTarget) => void;
export const renderSection = async (
  locale: 'en' | 'ko',
  props: React.ComponentProps<typeof SidebarExternalSection>,
) => {
  const instance = i18next.createInstance();
  await instance.init({
    lng: locale,
    fallbackLng: false,
    resources: { [locale]: { sidebar: locale === 'en' ? enSidebar : koSidebar } },
    ns: ['sidebar'],
    defaultNS: 'sidebar',
    interpolation: { escapeValue: false },
  });
  return renderToStaticMarkup(
    createElement(
      I18nextProvider,
      { i18n: instance },
      createElement(
        CompletionNotificationsProvider,
        null,
        createElement(SidebarExternalSection, props),
      ),
    ),
  );
};
