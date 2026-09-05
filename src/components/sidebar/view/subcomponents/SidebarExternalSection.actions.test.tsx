import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';

import type { TmuxPaneTarget } from '../../../../../shared/tmux';
import koSidebar from '../../../../i18n/locales/ko/sidebar.json';

import { external, noop, onOpen, process as makeProcess, project, renderSection, tmux } from './SidebarExternalSection.testSupport';
import { pendingExternalTranscriptDisposition } from './SidebarExternalSection';

test('SidebarExternalSection opens a fresh local agent in the pending conversation surface', async () => {
  const html = await renderSection('ko', {
    sessions: [external('omp-fresh', 'omp', '%4', 104)],
    projects: [project],
    onOpen,
    onChanged: noop,
  });
  assert.ok(html.includes(koSidebar.externalSessions.openConversation.replace('{{name}}', 'omp-fresh')));
  assert.ok(!html.includes('터미널로 보기'));
  assert.ok(html.includes('>READY<'), html);
  assert.ok(!html.includes('>대화 전<'), html);
  assert.ok(!html.includes('>확인 불가<'), html);
});


test('pending transcript promotion is fenced by the exact pane process generation', () => {
  const current = external('omp-fresh', 'omp', '%4', 104, {
    authority: 'rest',
    presence: 'present',
  });
  const pending: TmuxPaneTarget = {
    tmux: current.tmux,
    process: current.process!,
  };

  assert.equal(pendingExternalTranscriptDisposition(pending, current), 'wait');
  assert.equal(pendingExternalTranscriptDisposition(pending, {
    ...current,
    transcriptSessionId: 'indexed-current',
  }), 'promote');
  assert.equal(pendingExternalTranscriptDisposition(pending, {
    ...current,
    process: makeProcess(204),
    transcriptSessionId: 'indexed-replacement',
  }), 'clear');
  assert.equal(pendingExternalTranscriptDisposition(pending, {
    ...current,
    authority: 'none',
    transcriptSessionId: 'stale-index',
  }), 'clear');
  assert.equal(pendingExternalTranscriptDisposition(pending, {
    ...current,
    tmux: tmux('%different'),
    transcriptSessionId: 'different-pane',
  }), 'ignore');
});


test('SidebarExternalSection renders the unified English activity states without labelling SSH', async () => {
  const html = await renderSection('ko', {
    sessions: [
      external('claude-run', 'claude', '%5', 105, { activity: 'running' }),
      external('codex-wait', 'codex', '%6', 106, { activity: 'waiting_user' }),
      external('omp-ask', 'omp', '%7', 107, { activity: 'asking_user' }),
      external('cursor-unknown', 'cursor', '%8', 108, {
        activity: 'unknown',
        transcriptSessionId: 'cursor-session',
      }),
      external('opencode-error', 'opencode', '%10', 110, { activity: 'error' }),
      external('remote', 'ssh', '%9', 109),
    ],
    projects: [project],
    onOpen,
    onChanged: noop,
  });
  assert.ok(html.includes('>RUN<'), html);
  assert.ok(html.includes('>READY<'), html);
  assert.ok(html.includes('>INPUT<'), html);
  assert.ok(html.includes('>ERROR<'), html);
  assert.ok(!html.includes('>대기<'), html);
  assert.ok(!html.includes('>승인 대기<'), html);
  assert.ok(!html.includes('>확인 불가<'), html);
  assert.ok(!html.includes('>UNKNOWN<'), html);
});


test('M5b B8: the asking_user badge is a separate clickable attach entry point, distinct from the row open action', async () => {
  const html = await renderSection('ko', {
    sessions: [
      external('claude-ask', 'claude', '%20', 200, {
        transcriptSessionId: 'session-indexed',
        activity: 'asking_user',
      }),
    ],
    projects: [project],
    onOpen,
    onChanged: noop,
  });

  // The INPUT badge is a real <button>, not a span nested inside the row's
  // open button (which would make it non-independently-clickable / invalid
  // HTML), and it retains the translated accessible attach action.
  const approvalButtonMatch = html.match(/<button type="button"[^>]*aria-label="[^"]*claude-ask[^"]*"[^>]*>/);
  assert.ok(approvalButtonMatch, html);
  assert.ok(html.includes('claude-ask') && html.includes('터미널에 연결하여 에이전트에 응답'));

  // The badge button's own closing tag ends the only place its INPUT label may
  // legitimately appear; the row's own open button must not repeat it.
  const inputIndex = html.indexOf(approvalButtonMatch![0]);
  const inputButtonEnd = html.indexOf('</button>', inputIndex) + '</button>'.length;
  const duplicateInOpenButton = html.indexOf('INPUT</span>', inputButtonEnd);
  assert.equal(duplicateInOpenButton, -1, 'the INPUT badge must not also render inside the row open button');
});


test('M5b B8 AC1/AC2: the badge handler passes forceAttach with the exact pane it renders', () => {
  // The badge click seam cannot be exercised through renderToStaticMarkup, so
  // assert the handler contract at the source: attachToApproval must forward a
  // second argument carrying forceAttach, keyed on the session's own pane, and
  // the receiving handler must actually consume that argument. Both halves are
  // required — a dropped options parameter is legal TypeScript (parameter
  // bivariance) and would silently route approvals back to the transcript.
  const section = readFileSync(
    new URL('./SidebarExternalSection.tsx', import.meta.url),
    'utf8',
  );
  const handler = section.slice(
    section.indexOf('const attachToApproval'),
    section.indexOf('useEffect', section.indexOf('const attachToApproval')),
  );
  assert.match(handler, /onOpen\(\{[\s\S]*\},\s*\{\s*forceAttach:\s*true\s*\}\)/);
  assert.match(handler, /tmux:\s*session\.tmux/);
  assert.match(handler, /process:\s*session\.process/);
  assert.doesNotMatch(handler, /tmux:\s*sessions\[/);
  // A prior row click arms the promotion effect; leaving it armed would reopen
  // this pane as a transcript once it indexes and undo the forced attach.
  assert.match(handler, /pendingTranscriptRef\.current = null/);

  const appContent = readFileSync(
    new URL('../../../app/hooks/useExternalTerminalState.ts', import.meta.url),
    'utf8',
  );
  const opener = appContent.slice(
    appContent.indexOf('const openExternalTerminal'),
    appContent.indexOf('const closeExternalTerminal'),
  );
  assert.match(opener, /options\?:\s*\{\s*forceAttach\?:\s*boolean\s*\}/);
  assert.match(opener, /options\?\.forceAttach\s*\?\s*\{\s*\.\.\.target,\s*forceAttach:\s*true\s*\}/);
  assert.match(opener, /resolveExternalTerminalRoute\(routed\)/);
  assert.match(opener, /setExternalTerminal\(routed\)/);
});


test('SidebarExternalSection renders an unclassified shell pane as attach-only', async () => {
  const html = await renderSection('ko', {
    sessions: [external('scratch', 'shell', '%10', null)],
    projects: [project],
    onOpen,
    onChanged: noop,
  });
  assert.ok(html.includes('scratch'));
  assert.ok(html.includes('terminal'));
  assert.ok(html.includes('터미널로 보기'));
  assert.ok(!html.includes('%10'));
});


test('sidebar close controls terminate only the whole tmux session', () => {
  const externalSource = readFileSync(
    new URL('./SidebarExternalSection.tsx', import.meta.url),
    'utf8',
  );
  const externalCloseFlow = externalSource.slice(
    externalSource.indexOf('const closeTmuxSession'),
    externalSource.indexOf('if (sessions.length'),
  );
  assert.match(
    externalCloseFlow,
    /externalCliSessionKill\(session\.tmux,\s*session\.process,\s*'session'\)/,
  );
  assert.doesNotMatch(externalCloseFlow, /'process'|'pane'|mode:/);

  const liveSource = readFileSync(
    new URL('./SidebarLiveSection.tsx', import.meta.url),
    'utf8',
  );
  const liveCloseFlow = liveSource.slice(
    liveSource.indexOf('const closeTmuxSession'),
    liveSource.indexOf('\n  return (', liveSource.indexOf('const closeStrip')),
  );
  assert.match(
    liveCloseFlow,
    /liveSessionKill\(target\.tmux,\s*target\.process,\s*'session'\)/,
  );
  assert.doesNotMatch(liveCloseFlow, /'process'|'pane'|mode:/);
});
