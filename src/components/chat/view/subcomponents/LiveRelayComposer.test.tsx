import assert from 'node:assert/strict';
import test from 'node:test';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { api } from '../../../../utils/api';
import type { TmuxPaneTarget } from '../../../../../shared/tmux';
import {
  filterMentionableFiles,
  flattenProjectFileTree,
  getActiveMentionToken,
} from '../../utils/liveRelayComposer';

import LiveRelayComposer from './LiveRelayComposer';

const target: TmuxPaneTarget = {
  tmux: {
    socketPath: '/tmp/tmux-1000/default',
    sessionId: '$117',
    windowId: '@123',
    paneId: '%123',
  },
  process: { pid: 1285980, startedAtMs: 1_784_783_915_687 },
};

test('LiveRelayComposer identifies the target by tmux name without exposing raw coordinates', () => {
  const html = renderToStaticMarkup(createElement(LiveRelayComposer, {
    target,
    model: 'openai-codex/gpt-5.6-sol',
    effort: 'xhigh',
    sessionName: 'chatmux2',
    relayKind: 'omp',
  }));

  assert.ok(html.includes('gpt-5.6-sol'));
  assert.ok(html.includes('xhigh effort'));
  assert.ok(html.includes('chatmux2'));
  assert.ok(html.includes('chatmux2에 지시…'));
  assert.ok(!html.includes('$117'));
  assert.ok(!html.includes('%123'));
});

test('LiveRelayComposer uses a neutral label when no tmux name is available', () => {
  const html = renderToStaticMarkup(createElement(LiveRelayComposer, { target }));

  assert.ok(html.includes('현재 세션'));
  assert.ok(!html.includes('$117'));
  assert.ok(!html.includes('%123'));
});
test('LiveRelayComposer file mentions only activate at a token boundary and filter relative paths', () => {
  assert.deepEqual(getActiveMentionToken('review @src/com', 15), { start: 7, query: '@src/com' });
  assert.equal(getActiveMentionToken('email@src/com', 13), null);

  const files = flattenProjectFileTree([
    {
      name: 'src',
      type: 'directory',
      children: [{ name: 'composer.tsx', type: 'file' }],
    },
    { name: 'README.md', type: 'file' },
  ]);

  assert.deepEqual(filterMentionableFiles(files, '@composer'.slice(1)), [
    { name: 'composer.tsx', path: 'src/composer.tsx' },
  ]);
  assert.deepEqual(filterMentionableFiles(files, ''), files);
});

test('LiveRelayComposer does not discover files until an @ mention is active', () => {
  const projects = api.projects;
  const getFiles = api.getFiles;
  let calls = 0;
  api.projects = () => {
    calls += 1;
    return Promise.reject(new Error('unexpected request'));
  };
  api.getFiles = () => {
    calls += 1;
    return Promise.reject(new Error('unexpected request'));
  };

  try {
    renderToStaticMarkup(createElement(LiveRelayComposer, { target, workspacePath: '/workspace/project' }));
    assert.equal(calls, 0);
  } finally {
    api.projects = projects;
    api.getFiles = getFiles;
  }
});
