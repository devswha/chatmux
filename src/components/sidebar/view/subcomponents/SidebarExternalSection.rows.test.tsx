import assert from 'node:assert/strict';
import test from 'node:test';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { CompletionNotificationsProvider } from '../../context/CompletionNotificationsContext';
import koSidebar from '../../../../i18n/locales/ko/sidebar.json';

import { external, noop, onOpen, otherProject, project, renderSection } from './SidebarExternalSection.testSupport';
import SidebarExternalSection, {
  resolveExternalSessionProject,
} from './SidebarExternalSection';

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
