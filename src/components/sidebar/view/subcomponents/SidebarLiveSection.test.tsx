import assert from 'node:assert/strict';
import test from 'node:test';

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

const target = (paneId: string, pid: number): TmuxPaneTarget => ({
  tmux: { socketPath: '/tmp/chatmux.sock', sessionId: 'session-1', windowId: '@1', paneId },
  process: { pid, startedAtMs: 1_700_000_000_000 + pid },
});


const noop = () => {};
const onSessionSelect = noop as unknown as (session: ProjectSession, projectName: string) => void;
const onProjectSelect = noop as unknown as (project: Project) => void;

// The section's strings are ko-authored i18n resources; rendering with the ko
// locale keeps these SSR assertions pinned to the shipped translations.
const completionStatus = (sessionId: string, watched = true) => [
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

const renderSection = async (
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

function makeProjects(): Project[] {
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

test('SidebarLiveSection labels rows by tmux session name, title in tooltip', async () => {
  const html = await renderSection({
    projects: makeProjects(),
    liveSessionIds: new Set(['s-live']),
    liveSessionNames: new Map([['s-live', 'omg']]),
    liveSessionModels: new Map([['s-live', 'openai-codex/gpt-5.6-sol']]),
    liveSessionEfforts: new Map([['s-live', 'xhigh']]),
    liveSessionLineage: new Set(['s-live']),
    liveSessionTargets: new Map([['s-live', target('%1', 1)]]),
    liveSessionKinds: new Map([['s-live', 'interactive']]),
    liveSessionRunning: new Set<string>(),
    selectedSession: null,
    onProjectSelect,
    onSessionSelect,
  }, [completionStatus('s-live')]);
  assert.ok(html.includes('>omg<'), 'primary label is the tmux session name');
  assert.ok(html.includes('Proj One'), 'shows the project name');
  assert.ok(html.includes('gpt-5.6-sol · xhigh effort · Proj One'), 'shows model and reasoning effort');
  assert.ok(html.includes('title="Live conversation title"'), 'conversation title is demoted to the tooltip');
  assert.ok(!html.includes('Idle conversation'), 'omits non-live sessions');
  assert.ok(!html.includes('배치'), 'an interactive gjc TUI carries no batch badge');
  assert.ok(html.includes('이 세션의 어시스턴트 응답 준비 완료 알림 끄기'), 'matched lineage rows render their completion bell');
  assert.ok(
    html.indexOf('이 세션의 어시스턴트 응답 준비 완료 알림 끄기') < html.indexOf('title="omg 종료 옵션"'),
    'the completion bell stays left of the matched row stop control',
  );
});

test('SidebarLiveSection hides a live transcript that has no tmux pane', async () => {
  const html = await renderSection({
    projects: makeProjects(),
    liveSessionIds: new Set(['s-live']),
    liveSessionNames: new Map(),
    liveSessionLineage: new Set<string>(),
    liveSessionTargets: new Map<string, TmuxPaneTarget>(),
    liveSessionKinds: new Map<string, string>(),
    liveSessionRunning: new Set(['s-live']),
    selectedSession: null,
    onProjectSelect,
    onSessionSelect,
  });
  assert.equal(html, '', 'non-tmux processes stay in transcript history, not the tmux roster');
});
test('SidebarLiveSection renders a completion bell for a matched GJC row without kill lineage', async () => {
  const html = await renderSection({
    projects: makeProjects(),
    liveSessionIds: new Set(['s-live']),
    liveSessionNames: new Map([['s-live', 'unclaimed']]),
    liveSessionLineage: new Set<string>(),
    liveSessionTargets: new Map<string, TmuxPaneTarget>(),
    liveSessionKinds: new Map([['s-live', 'interactive']]),
    liveSessionRunning: new Set<string>(),
    selectedSession: null,
    onProjectSelect,
    onSessionSelect,
  }, [completionStatus('s-live')]);
  assert.ok(html.includes('이 세션의 어시스턴트 응답 준비 완료 알림 끄기'));
  assert.ok(!html.includes('unclaimed 종료 옵션'), 'no-lineage rows remain non-killable');
});


test('SidebarLiveSection renders nothing when no session is live', async () => {
  const html = await renderSection({
    projects: makeProjects(),
    liveSessionIds: new Set<string>(),
    liveSessionNames: new Map(),
    liveSessionLineage: new Set<string>(),
    liveSessionTargets: new Map<string, TmuxPaneTarget>(),
    liveSessionKinds: new Map<string, string>(),
    liveSessionRunning: new Set<string>(),
    selectedSession: null,
    onProjectSelect,
    onSessionSelect,
  });
  assert.equal(html, '');
});

test('SidebarLiveSection renders idle-gjc rows as 대기 (첫 대화 전 gjc pane)', async () => {
  const html = await renderSection({
    projects: makeProjects(),
    liveSessionIds: new Set(['idle-gjc:flask']),
    liveSessionNames: new Map([['idle-gjc:flask', 'flask']]),
    liveSessionLineage: new Set(['idle-gjc:flask']),
    liveSessionTargets: new Map([['idle-gjc:flask', target('%9', 9)]]),
    liveSessionKinds: new Map([['idle-gjc:flask', 'interactive']]),
    liveSessionRunning: new Set<string>(),
    selectedSession: null,
    onProjectSelect,
    onSessionSelect,
  }, [completionStatus('idle-gjc:flask')]);
  assert.ok(html.includes('flask 종료 옵션'), 'lineage-grade idle rows keep the kill control');
  assert.ok(html.includes('대기'), 'idle rows carry the 대기 badge, not LIVE');
  assert.ok(!html.includes('LIVE'), 'no LIVE badge for a session with no transcript');
  assert.ok(html.includes('눌러서 첫 대화 시작'), 'opens a full pending transcript view');
  assert.ok(html.includes("tmux 세션 &#x27;flask&#x27;에서 첫 대화 시작"), 'the idle row itself is clickable');
  assert.ok(html.includes('첫 메시지 보내기'), 'idle lineage rows offer the first-message composer');
  assert.ok(html.includes('flask 종료 옵션'), 'lineage-grade idle rows keep the kill control');
  assert.ok(!html.includes('이 세션의 어시스턴트 응답 준비 완료 알림'), 'synthetic idle rows omit completion bells');
});

test('SidebarLiveSection badges a batch gjc row (foreground command is not gjc)', async () => {
  const html = await renderSection({
    projects: makeProjects(),
    liveSessionIds: new Set(['s-live']),
    liveSessionNames: new Map([['s-live', 'stock']]),
    liveSessionLineage: new Set(['s-live']),
    liveSessionTargets: new Map([['s-live', target('%2', 2)]]),
    liveSessionKinds: new Map([['s-live', 'batch']]),
    liveSessionRunning: new Set<string>(),
    selectedSession: null,
    onProjectSelect,
    onSessionSelect,
  });
  // A batch gjc descendant is still a live, kill-eligible row (LIVE + kill control)
  // but is visually distinguished from an interactive gjc TUI.
  assert.ok(html.includes('LIVE'), 'a batch row is still LIVE');
  assert.ok(html.includes('배치'), 'a batch gjc descendant carries the 배치 badge');
});

// Regression: a session whose transcript tail shows a turn in progress must be
// visually distinct (green RUN) from one waiting for input (blue LIVE).
test('SidebarLiveSection badges an in-progress turn as RUN, not LIVE', async () => {
  const html = await renderSection({
    projects: makeProjects(),
    liveSessionIds: new Set(['s-live']),
    liveSessionNames: new Map([['s-live', 'omg']]),
    liveSessionLineage: new Set(['s-live']),
    liveSessionTargets: new Map([['s-live', target('%1', 1)]]),
    liveSessionKinds: new Map([['s-live', 'interactive']]),
    liveSessionRunning: new Set(['s-live']),
    selectedSession: null,
    onProjectSelect,
    onSessionSelect,
  });
  assert.ok(html.includes('>RUN<'), 'an in-progress turn carries the RUN badge');
  assert.ok(!html.includes('>LIVE<'), 'the same row does not also show LIVE');
  assert.ok(html.includes('emerald'), 'RUN is styled green, not blue');
});

test('SidebarLiveSection makes transcript-backed orphan rows directly openable', async () => {
  const html = await renderSection({
    projects: makeProjects(),
    liveSessionIds: new Set(['s-resumed']),
    liveSessionNames: new Map([['s-resumed', 'resume-pane']]),
    liveSessionLineage: new Set<string>(),
    liveSessionTargets: new Map<string, TmuxPaneTarget>(),
    liveSessionKinds: new Map([['s-resumed', 'interactive']]),
    liveSessionRunning: new Set<string>(),
    selectedSession: null,
    onProjectSelect,
    onSessionSelect,
  }, [completionStatus('s-resumed')]);
  assert.ok(html.includes('<button'), 'a transcript-backed orphan is interactive');
  assert.ok(html.includes('눌러서 이전 대화 열기'), 'explains that the previous transcript opens directly');
  assert.ok(!html.includes('대화 미로딩'), 'does not present pagination as a transcript loading failure');
  assert.ok(html.includes('이 세션의 어시스턴트 응답 준비 완료 알림 끄기'), 'real orphan rows render their completion bell');
});
