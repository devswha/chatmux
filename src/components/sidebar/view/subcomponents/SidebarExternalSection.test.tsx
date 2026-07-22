import assert from 'node:assert/strict';
import test from 'node:test';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { ExternalTerminalTarget, Project } from '../../../../types/app';

import SidebarExternalSection, { resolveExternalSessionProject } from './SidebarExternalSection';

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

test('resolveExternalSessionProject selects the transcript owner instead of the first project', () => {
  assert.equal(
    resolveExternalSessionProject({
      tmuxName: 'omp-other',
      kind: 'omp',
      projectPath: '/workspace/other/',
    }, [project, otherProject]),
    otherProject,
  );
});

test('SidebarExternalSection shows Codex transcript name, model, and tmux name', () => {
  const html = renderToStaticMarkup(createElement(SidebarExternalSection, {
    sessions: [{
      tmuxName: 'codex-review',
      kind: 'codex' as const,
      transcriptSessionId: 'session-1',
      sessionName: 'Adversarial review',
      model: 'openai-codex/gpt-5.6-sol',
    }],
    projects: [project],
    onOpen,
    onChanged: noop,
  }));

  assert.ok(html.includes('Adversarial review'), 'uses the transcript name as the primary label');
  assert.ok(html.includes('gpt-5.6-sol · codex-review · Codex CLI'), 'shows model and tmux metadata');
});

test('SidebarExternalSection shows an indexed Claude session as a structured transcript', () => {
  const html = renderToStaticMarkup(createElement(SidebarExternalSection, {
    sessions: [{
      tmuxName: 'claude-review',
      kind: 'claude' as const,
      transcriptSessionId: 'session-claude',
      sessionName: 'Architecture review',
      model: 'claude-sonnet-4-6',
    }],
    projects: [project],
    onOpen,
    onChanged: noop,
  }));

  assert.ok(html.includes('Architecture review'), 'uses the Claude transcript name');
  assert.ok(html.includes('claude-sonnet-4-6 · claude-review · Claude Code'));
  assert.ok(!html.includes('터미널로 보기'), 'indexed Claude row no longer advertises terminal attach');
});

test('SidebarExternalSection renders an indexed Oh My Pi transcript with its provider mark', () => {
  const html = renderToStaticMarkup(createElement(SidebarExternalSection, {
    sessions: [{
      tmuxName: 'omp-review',
      kind: 'omp' as const,
      transcriptSessionId: 'session-omp',
      sessionName: 'Pi integration review',
      model: 'openai-codex/gpt-5.6-sol',
    }],
    projects: [project],
    onOpen,
    onChanged: noop,
  }));

  assert.ok(html.includes('Pi integration review'));
  assert.ok(html.includes('gpt-5.6-sol · omp-review · Oh My Pi'));
  assert.ok(html.includes('aria-label="Oh My Pi"'));
});

test('SidebarExternalSection opens a fresh local agent in the pending conversation surface', () => {
  const html = renderToStaticMarkup(createElement(SidebarExternalSection, {
    sessions: [{
      tmuxName: 'omp-fresh',
      kind: 'omp' as const,
    }],
    projects: [project],
    onOpen,
    onChanged: noop,
  }));

  assert.ok(html.includes('omp-fresh — 대화 열기'));
  assert.ok(!html.includes('터미널로 보기'));
});

test('SidebarExternalSection renders provider-native activity states without labelling SSH', () => {
  const html = renderToStaticMarkup(createElement(SidebarExternalSection, {
    sessions: [
      { tmuxName: 'claude-run', kind: 'claude' as const, activity: 'running' as const },
      { tmuxName: 'codex-wait', kind: 'codex' as const, activity: 'waiting_user' as const },
      { tmuxName: 'omp-ask', kind: 'omp' as const, activity: 'asking_user' as const },
      { tmuxName: 'cursor-unknown', kind: 'cursor' as const, activity: 'unknown' as const },
      { tmuxName: 'remote', kind: 'ssh' as const },
    ],
    projects: [project],
    onOpen,
    onChanged: noop,
  }));

  assert.ok(html.includes('>RUN<'));
  assert.ok(html.includes('>대기<'));
  assert.ok(html.includes('>질문<'));
  assert.ok(html.includes('>확인 불가<'));
  assert.ok(html.includes('다음 사용자 입력을 기다립니다'));
});
