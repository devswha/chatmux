import assert from 'node:assert/strict';
import test from 'node:test';

import type { TmuxPaneTarget } from '../../../../../shared/tmux';
import koSidebar from '../../../../i18n/locales/ko/sidebar.json';

import { completionStatus, makeProjects, onProjectSelect, onSessionSelect, renderSection, target } from './SidebarLiveSection.testSupport';

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
  assert.ok(!html.includes(koSidebar.liveSessions.closeSessionTitle.replace('{{name}}', 'unclaimed').replace(/'/g, '&#x27;')), 'no-lineage rows remain non-killable');
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


test('SidebarLiveSection renders first-message GJC panes as READY', async () => {
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
  assert.ok(html.includes(koSidebar.liveSessions.closeSessionTitle.replace('{{name}}', 'flask').replace(/'/g, '&#x27;')), 'lineage-grade idle rows keep the close control');
  assert.ok(html.includes('>READY<'), 'first-message rows use the unified READY state');
  assert.ok(!html.includes('>LIVE<'), 'the obsolete LIVE state is not rendered');
  assert.ok(html.includes('눌러서 첫 대화 시작'), 'opens a full pending transcript view');
  assert.ok(html.includes("tmux 세션 &#x27;flask&#x27;에서 첫 대화 시작"), 'the idle row itself is clickable');
  assert.ok(!html.includes('첫 메시지 보내기'), 'idle rows no longer render an inline first-message composer');
  assert.ok(html.includes(koSidebar.liveSessions.closeSessionTitle.replace('{{name}}', 'flask').replace(/'/g, '&#x27;')), 'lineage-grade idle rows keep the close control');
  assert.ok(!html.includes('이 세션의 어시스턴트 응답 준비 완료 알림'), 'synthetic idle rows omit completion bells');
});


test('SidebarLiveSection explains why an unsafe GJC binding was excluded', async () => {
  const id = 'idle-gjc:foreign:%91';
  const html = await renderSection({
    projects: makeProjects(),
    liveSessionIds: new Set([id]),
    liveSessionNames: new Map([[id, 'foreign']]),
    liveSessionLineage: new Set<string>(),
    liveSessionTargets: new Map<string, TmuxPaneTarget>(),
    liveSessionKinds: new Map([[id, 'interactive']]),
    liveSessionRunning: new Set<string>(),
    liveSessionConnectionIssues: new Map([[id, 'agent_home_mismatch']]),
    selectedSession: null,
    onProjectSelect,
    onSessionSelect,
  });
  assert.ok(html.includes('GJC 연결 제외: ChatMux와 HOME 경로가 다릅니다.'));
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
  // A batch GJC descendant remains ready and kill-eligible, while its execution
  // shape is visually distinguished from the activity state.
  assert.ok(html.includes('>READY<'), 'an idle batch row is READY');
  assert.ok(html.includes('>BATCH<'), 'a batch GJC descendant carries the English BATCH tag');
});

// Regression: a session whose transcript tail shows a turn in progress must be
// visually distinct (green RUN) from one ready for input (blue READY).


test('SidebarLiveSection badges an in-progress turn as RUN, not READY', async () => {
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
  assert.ok(!html.includes('>READY<'), 'the same row does not also show READY');
  assert.ok(html.includes('emerald'), 'RUN is styled green, not blue');
});


test('SidebarLiveSection gives an active GJC choice prompt INPUT precedence over RUN', async () => {
  const html = await renderSection({
    projects: makeProjects(),
    liveSessionIds: new Set(['s-live']),
    liveSessionNames: new Map([['s-live', 'omg']]),
    liveSessionLineage: new Set(['s-live']),
    liveSessionTargets: new Map([['s-live', target('%1', 1)]]),
    liveSessionKinds: new Map([['s-live', 'interactive']]),
    liveSessionRunning: new Set(['s-live']),
    liveSessionInput: new Set(['s-live']),
    selectedSession: null,
    onProjectSelect,
    onSessionSelect,
  });
  assert.ok(html.includes('>INPUT<'));
  assert.ok(!html.includes('>RUN<'));
  assert.ok(!html.includes('>READY<'));
});


test('SidebarLiveSection gives GJC provider failures ERROR precedence over RUN and READY', async () => {
  const html = await renderSection({
    projects: makeProjects(),
    liveSessionIds: new Set(['s-live']),
    liveSessionNames: new Map([['s-live', 'overloaded']]),
    liveSessionLineage: new Set(['s-live']),
    liveSessionTargets: new Map([['s-live', target('%1', 1)]]),
    liveSessionKinds: new Map([['s-live', 'interactive']]),
    liveSessionRunning: new Set(['s-live']),
    liveSessionErrors: new Set(['s-live']),
    selectedSession: null,
    onProjectSelect,
    onSessionSelect,
  });

  assert.ok(html.includes('>ERROR<'));
  assert.ok(!html.includes('>RUN<'));
  assert.ok(!html.includes('>READY<'));
  assert.ok(html.includes('text-red-'));
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
