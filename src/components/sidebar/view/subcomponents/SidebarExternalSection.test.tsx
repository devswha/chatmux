import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';

import i18next from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import enSidebar from '../../../../i18n/locales/en/sidebar.json';
import koSidebar from '../../../../i18n/locales/ko/sidebar.json';
import type { ExternalTerminalTarget, Project } from '../../../../types/app';
import type { TmuxPaneIdentity, TmuxPaneTarget, TmuxProcessGeneration } from '../../../../../shared/tmux';
import { CompletionNotificationsProvider } from '../../context/CompletionNotificationsContext';

import SidebarExternalSection, {
  pendingExternalTranscriptDisposition,
  resolveExternalSessionProject,
} from './SidebarExternalSection';


const tmux = (paneId: string): TmuxPaneIdentity => ({
  socketPath: '/tmp/chatmux.sock',
  sessionId: 'session-1',
  windowId: '@1',
  paneId,
});
const process = (pid: number): TmuxProcessGeneration => ({ pid, startedAtMs: 1_700_000_000_000 + pid });
const external = (
  tmuxName: string,
  kind: 'claude' | 'codex' | 'cursor' | 'opencode' | 'omp' | 'ssh' | 'shell',
  paneId: string,
  pid: number | null,
  extra: Record<string, unknown> = {},
) => ({
  tmuxName, tmux: tmux(paneId), process: pid === null ? null : process(pid), kind, ...extra,
});
const project = {
  projectId: 'project-1',
  displayName: 'ChatMux',
  fullPath: '/workspace/chatmux',
} satisfies Project;

const otherProject = {
  projectId: 'project-2',
  displayName: 'Other',
  fullPath: '/workspace/other',
} satisfies Project;

const noop = () => {};
const onOpen = noop as unknown as (target: ExternalTerminalTarget) => void;
const renderSection = async (
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

test('resolveExternalSessionProject selects the transcript owner instead of the first project', () => {
  assert.equal(
    resolveExternalSessionProject({
      ...external('omp-other', 'omp', '%0', 100),
      projectPath: '/workspace/other/',
    }, [project, otherProject]),
    otherProject,
  );
});

test('resolveExternalSessionProject never falls back to an unrelated project', () => {
  assert.equal(
    resolveExternalSessionProject(
      external('shell-unmatched', 'shell', '%0', null, { projectPath: '/workspace/missing' }),
      [project, otherProject],
    ),
    null,
  );
});

test('SidebarExternalSection uses the tmux name as primary and transcript metadata as secondary', () => {
  const html = renderToStaticMarkup(
    createElement(
      CompletionNotificationsProvider,
      null,
      createElement(SidebarExternalSection, {
        sessions: [external('codex-review', 'codex', '%1', 101, {
          transcriptSessionId: 'session-1',
          sessionName: 'Adversarial review',
          model: 'openai-codex/gpt-5.6-sol',
          effort: 'xhigh',
        })],
        projects: [project],
        onOpen,
        onChanged: noop,
      }),
    ),
  );
  assert.ok(html.includes('>codex-review</span>'), 'uses the tmux session name as the primary label');
  assert.ok(html.includes('Adversarial review · gpt-5.6-sol · xhigh effort · Codex CLI'), 'shows model and reasoning effort without raw tmux ids');
  assert.ok(!html.includes('%1'));
});

test('SidebarExternalSection explains why an unsafe agent binding was excluded', async () => {
  const html = await renderSection('ko', {
    sessions: [external('foreign-codex', 'codex', '%91', 191, {
      authority: 'stream',
      presence: 'present',
      connectionIssue: 'agent_user_mismatch',
    })],
    projects: [project],
    onOpen,
    onChanged: noop,
  });
  assert.ok(html.includes('Codex CLI 연결 제외: ChatMux와 실행 사용자가 다릅니다.'));
  assert.ok(html.includes('>ERROR<'));
  assert.ok(!html.includes(koSidebar.externalSessions.closeSessionTitle.replace('{{name}}', 'foreign-codex')));
});

test('SidebarExternalSection renders an actionable external-only row without Projects', () => {
  const html = renderToStaticMarkup(
    createElement(
      CompletionNotificationsProvider,
      null,
      createElement(SidebarExternalSection, {
        sessions: [external('remote-shell', 'shell', '%10', null, {
          projectPath: '/srv/work',
          attachCapability: 'opaque-capability',
        })],
        projects: [],
        onOpen,
        onChanged: noop,
      }),
    ),
  );

  assert.match(html, />remote-shell<\/span>/);
  assert.doesNotMatch(html, /aria-disabled="true"/);
});

test('SidebarExternalSection keeps unavailable or stale identity rows inert', async () => {
  const html = await renderSection('ko', {
    sessions: [
      external('unavailable-agent', 'claude', '%11', 111, {
        projectPath: project.fullPath,
        transcriptSessionId: 'stale-transcript',
        attachCapability: 'stale-capability',
        activity: 'asking_user',
        presence: 'present',
        authority: 'none',
      }),
      external('stale-agent', 'opencode', '%12', 112, {
        projectPath: project.fullPath,
        activity: 'error',
        presence: 'stale',
        authority: 'stream',
      }),
    ],
    projects: [project],
    onOpen,
    onChanged: noop,
  });

  assert.match(html, />unavailable-agent<\/span>/);
  assert.match(html, />stale-agent<\/span>/);
  assert.equal((html.match(/aria-disabled="true"/g) ?? []).length, 2, html);
  assert.doesNotMatch(html, />INPUT</);
  assert.doesNotMatch(html, />ERROR</);
  assert.doesNotMatch(html, /대기 중인 승인에 답하기/);
  assert.doesNotMatch(html, /tmux 세션 '(?:unavailable-agent|stale-agent)' 닫기/);
});

test('SidebarExternalSection shows an indexed Claude session as a structured transcript', () => {
  const html = renderToStaticMarkup(
    createElement(
      CompletionNotificationsProvider,
      null,
      createElement(SidebarExternalSection, {
        sessions: [external('claude-review', 'claude', '%2', 102, {
          transcriptSessionId: 'session-claude',
          sessionName: 'Architecture review',
          model: 'claude-sonnet-4-6',
        })],
        projects: [project],
        onOpen,
        onChanged: noop,
      }),
    ),
  );
  assert.ok(html.includes('>claude-review</span>'), 'uses the Claude tmux name as primary');
  assert.ok(html.includes('Architecture review · claude-sonnet-4-6 · Claude Code'));
  assert.ok(!html.includes('%2'));
  assert.ok(!html.includes('터미널로 보기'), 'indexed Claude row no longer advertises terminal attach');
});

test('SidebarExternalSection renders an indexed Oh My Pi transcript with its provider mark', () => {
  const html = renderToStaticMarkup(
    createElement(
      CompletionNotificationsProvider,
      null,
      createElement(SidebarExternalSection, {
        sessions: [external('omp-review', 'omp', '%3', 103, {
          transcriptSessionId: 'session-omp',
          sessionName: 'Pi integration review',
          model: 'openai-codex/gpt-5.6-sol',
        })],
        projects: [project],
        onOpen,
        onChanged: noop,
      }),
    ),
  );
  assert.ok(html.includes('Pi integration review · gpt-5.6-sol · Oh My Pi'));
  assert.ok(!html.includes('%3'));
  assert.ok(html.includes('aria-label="Oh My Pi"'));
});

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
    process: process(204),
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
  assert.ok(html.includes('claude-ask') && html.includes('에 연결해 대기 중인 승인에 답하기'));

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
    new URL('../../../app/AppContent.tsx', import.meta.url),
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
