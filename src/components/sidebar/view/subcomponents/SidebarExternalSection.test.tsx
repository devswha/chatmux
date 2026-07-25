import assert from 'node:assert/strict';
import test from 'node:test';

import i18next from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import enSidebar from '../../../../i18n/locales/en/sidebar.json';
import koSidebar from '../../../../i18n/locales/ko/sidebar.json';
import type { ExternalTerminalTarget, Project } from '../../../../types/app';
import type { TmuxPaneIdentity, TmuxProcessGeneration } from '../../../../../shared/tmux';

import SidebarExternalSection, { resolveExternalSessionProject } from './SidebarExternalSection';


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
      createElement(SidebarExternalSection, props),
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

test('SidebarExternalSection uses the tmux name as primary and transcript metadata as secondary', () => {
  const html = renderToStaticMarkup(createElement(SidebarExternalSection, {
    sessions: [external('codex-review', 'codex', '%1', 101, {
      transcriptSessionId: 'session-1',
      sessionName: 'Adversarial review',
      model: 'openai-codex/gpt-5.6-sol',
      effort: 'xhigh',
    })],
    projects: [project],
    onOpen,
    onChanged: noop,
  }));
  assert.ok(html.includes('>codex-review</span>'), 'uses the tmux session name as the primary label');
  assert.ok(html.includes('Adversarial review · gpt-5.6-sol · xhigh effort · Codex CLI'), 'shows model and reasoning effort without raw tmux ids');
  assert.ok(!html.includes('%1'));
});

test('SidebarExternalSection shows an indexed Claude session as a structured transcript', () => {
  const html = renderToStaticMarkup(createElement(SidebarExternalSection, {
    sessions: [external('claude-review', 'claude', '%2', 102, {
      transcriptSessionId: 'session-claude',
      sessionName: 'Architecture review',
      model: 'claude-sonnet-4-6',
    })],
    projects: [project],
    onOpen,
    onChanged: noop,
  }));
  assert.ok(html.includes('>claude-review</span>'), 'uses the Claude tmux name as primary');
  assert.ok(html.includes('Architecture review · claude-sonnet-4-6 · Claude Code'));
  assert.ok(!html.includes('%2'));
  assert.ok(!html.includes('터미널로 보기'), 'indexed Claude row no longer advertises terminal attach');
});

test('SidebarExternalSection renders an indexed Oh My Pi transcript with its provider mark', () => {
  const html = renderToStaticMarkup(createElement(SidebarExternalSection, {
    sessions: [external('omp-review', 'omp', '%3', 103, {
      transcriptSessionId: 'session-omp',
      sessionName: 'Pi integration review',
      model: 'openai-codex/gpt-5.6-sol',
    })],
    projects: [project],
    onOpen,
    onChanged: noop,
  }));
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
});

test('SidebarExternalSection renders provider-native activity states without labelling SSH', async () => {
  const html = await renderSection('ko', {
    sessions: [
      external('claude-run', 'claude', '%5', 105, { activity: 'running' }),
      external('codex-wait', 'codex', '%6', 106, { activity: 'waiting_user' }),
      external('omp-ask', 'omp', '%7', 107, { activity: 'asking_user' }),
      external('cursor-unknown', 'cursor', '%8', 108, { activity: 'unknown' }),
      external('remote', 'ssh', '%9', 109),
    ],
    projects: [project],
    onOpen,
    onChanged: noop,
  });
  assert.ok(html.includes('RUN'), html);
  assert.ok(html.includes('>대기<'));
  assert.ok(html.includes('>승인 대기<'));
  assert.ok(html.includes('>확인 불가<'));
  assert.ok(html.includes('다음 사용자 입력을 기다립니다'));
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
