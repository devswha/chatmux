import assert from 'node:assert/strict';
import test from 'node:test';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { Project, ProjectSession } from '../../../../types/app';

import SidebarLiveSection from './SidebarLiveSection';

const noop = () => {};
const onSessionSelect = noop as unknown as (session: ProjectSession, projectName: string) => void;

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
      liveSessionLineage: new Set(['s-live']),
      liveSessionTmuxIds: new Map([['s-live', '$1']]),
      liveSessionKinds: new Map([['s-live', 'interactive']]),
      selectedSession: null,
      onSessionSelect,
    }),
  );
  assert.ok(html.includes('>omg<'), 'primary label is the tmux session name');
  assert.ok(html.includes('Proj One'), 'shows the project name');
  assert.ok(html.includes('title="Live conversation title"'), 'conversation title is demoted to the tooltip');
  assert.ok(!html.includes('Idle conversation'), 'omits non-live sessions');
  assert.ok(!html.includes('배치'), 'an interactive gjc TUI carries no batch badge');
});

test('SidebarLiveSection falls back to the conversation title when tmux name is unknown', () => {
  const html = renderToStaticMarkup(
    createElement(SidebarLiveSection, {
      projects: makeProjects(),
      liveSessionIds: new Set(['s-live']),
      liveSessionNames: new Map(),
      liveSessionLineage: new Set<string>(),
      liveSessionTmuxIds: new Map<string, string>(),
      liveSessionKinds: new Map<string, string>(),
      selectedSession: null,
      onSessionSelect,
    }),
  );
  assert.ok(html.includes('Live conversation title'), 'primary label falls back to the title');
});

test('SidebarLiveSection renders nothing when no session is live', () => {
  const html = renderToStaticMarkup(
    createElement(SidebarLiveSection, {
      projects: makeProjects(),
      liveSessionIds: new Set<string>(),
      liveSessionNames: new Map(),
      liveSessionLineage: new Set<string>(),
      liveSessionTmuxIds: new Map<string, string>(),
      liveSessionKinds: new Map<string, string>(),
      selectedSession: null,
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
      liveSessionTmuxIds: new Map([['idle-gjc:flask', '$9']]),
      liveSessionKinds: new Map([['idle-gjc:flask', 'interactive']]),
      selectedSession: null,
      onSessionSelect,
    }),
  );
  assert.ok(html.includes('>flask<'), 'labels the row by tmux session name');
  assert.ok(html.includes('대기'), 'idle rows carry the 대기 badge, not LIVE');
  assert.ok(!html.includes('LIVE'), 'no LIVE badge for a session with no transcript');
  assert.ok(html.includes('아직 대화가 없습니다'), 'explains the pre-transcript state');
  assert.ok(html.includes('첫 메시지 보내기'), 'idle lineage rows offer the first-message composer');
  assert.ok(html.includes('tmux 세션 flask 닫기'), 'lineage-grade idle rows keep the kill control');
});

test('SidebarLiveSection badges a batch gjc row (foreground command is not gjc)', () => {
  const html = renderToStaticMarkup(
    createElement(SidebarLiveSection, {
      projects: makeProjects(),
      liveSessionIds: new Set(['s-live']),
      liveSessionNames: new Map([['s-live', 'stock']]),
      liveSessionLineage: new Set(['s-live']),
      liveSessionTmuxIds: new Map([['s-live', '$2']]),
      liveSessionKinds: new Map([['s-live', 'batch']]),
      selectedSession: null,
      onSessionSelect,
    }),
  );
  // A batch gjc descendant is still a live, kill-eligible row (LIVE + kill control)
  // but is visually distinguished from an interactive gjc TUI.
  assert.ok(html.includes('LIVE'), 'a batch row is still LIVE');
  assert.ok(html.includes('배치'), 'a batch gjc descendant carries the 배치 badge');
});
