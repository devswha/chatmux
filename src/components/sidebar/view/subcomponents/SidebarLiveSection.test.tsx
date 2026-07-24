import assert from 'node:assert/strict';
import test from 'node:test';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { Project, ProjectSession } from '../../../../types/app';
import type { TmuxPaneTarget } from '../../../../../shared/tmux';

const target = (paneId: string, pid: number): TmuxPaneTarget => ({
  tmux: { socketPath: '/tmp/chatmux.sock', sessionId: 'session-1', windowId: '@1', paneId },
  process: { pid, startedAtMs: 1_700_000_000_000 + pid },
});
import SidebarLiveSection from './SidebarLiveSection';

const noop = () => {};
const onSessionSelect = noop as unknown as (session: ProjectSession, projectName: string) => void;
const onProjectSelect = noop as unknown as (project: Project) => void;

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

test('SidebarLiveSection labels rows by tmux session name, title in tooltip', () => {
  const html = renderToStaticMarkup(
    createElement(SidebarLiveSection, {
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
    }),
  );
  assert.ok(html.includes('>omg<'), 'primary label is the tmux session name');
  assert.ok(html.includes('Proj One'), 'shows the project name');
  assert.ok(html.includes('gpt-5.6-sol · xhigh effort · Proj One'), 'shows model and reasoning effort');
  assert.ok(html.includes('title="Live conversation title"'), 'conversation title is demoted to the tooltip');
  assert.ok(!html.includes('Idle conversation'), 'omits non-live sessions');
  assert.ok(!html.includes('배치'), 'an interactive gjc TUI carries no batch badge');
});

test('SidebarLiveSection hides a live transcript that has no tmux pane', () => {
  const html = renderToStaticMarkup(
    createElement(SidebarLiveSection, {
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
    }),
  );
  assert.equal(html, '', 'non-tmux processes stay in transcript history, not the tmux roster');
});

test('SidebarLiveSection renders nothing when no session is live', () => {
  const html = renderToStaticMarkup(
    createElement(SidebarLiveSection, {
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
    }),
  );
  assert.equal(html, '');
});

test('SidebarLiveSection renders idle-gjc rows as 대기 (첫 대화 전 gjc pane)', () => {
  const html = renderToStaticMarkup(
    createElement(SidebarLiveSection, {
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
    }),
  );
  assert.ok(html.includes('flask 종료 옵션'), 'lineage-grade idle rows keep the kill control');
  assert.ok(html.includes('대기'), 'idle rows carry the 대기 badge, not LIVE');
  assert.ok(!html.includes('LIVE'), 'no LIVE badge for a session with no transcript');
  assert.ok(html.includes('눌러서 첫 대화 시작'), 'opens a full pending transcript view');
  assert.ok(html.includes("tmux 세션 &#x27;flask&#x27;에서 첫 대화 시작"), 'the idle row itself is clickable');
  assert.ok(html.includes('첫 메시지 보내기'), 'idle lineage rows offer the first-message composer');
  assert.ok(html.includes('flask 종료 옵션'), 'lineage-grade idle rows keep the kill control');
});

test('SidebarLiveSection badges a batch gjc row (foreground command is not gjc)', () => {
  const html = renderToStaticMarkup(
    createElement(SidebarLiveSection, {
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
    }),
  );
  // A batch gjc descendant is still a live, kill-eligible row (LIVE + kill control)
  // but is visually distinguished from an interactive gjc TUI.
  assert.ok(html.includes('LIVE'), 'a batch row is still LIVE');
  assert.ok(html.includes('배치'), 'a batch gjc descendant carries the 배치 badge');
});

// Regression: a session whose transcript tail shows a turn in progress must be
// visually distinct (green RUN) from one waiting for input (blue LIVE).
test('SidebarLiveSection badges an in-progress turn as RUN, not LIVE', () => {
  const html = renderToStaticMarkup(
    createElement(SidebarLiveSection, {
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
    }),
  );
  assert.ok(html.includes('>RUN<'), 'an in-progress turn carries the RUN badge');
  assert.ok(!html.includes('>LIVE<'), 'the same row does not also show LIVE');
  assert.ok(html.includes('emerald'), 'RUN is styled green, not blue');
});

test('SidebarLiveSection makes transcript-backed orphan rows directly openable', () => {
  const html = renderToStaticMarkup(
    createElement(SidebarLiveSection, {
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
    }),
  );
  assert.ok(html.includes('<button'), 'a transcript-backed orphan is interactive');
  assert.ok(html.includes('눌러서 이전 대화 열기'), 'explains that the previous transcript opens directly');
  assert.ok(!html.includes('대화 미로딩'), 'does not present pagination as a transcript loading failure');
});
