import assert from 'node:assert/strict';
import test from 'node:test';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { ExternalTerminalTarget, Project } from '../../../../types/app';

import SidebarExternalSection from './SidebarExternalSection';

const project = {
  projectId: 'project-1',
  displayName: 'ChatMux',
  fullPath: '/workspace/chatmux',
} satisfies Project;

const noop = () => {};
const onOpen = noop as unknown as (target: ExternalTerminalTarget) => void;

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
