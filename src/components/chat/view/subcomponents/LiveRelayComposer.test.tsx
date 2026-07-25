import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import '../../../../i18n/config';

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
test('LiveRelayComposer exposes interrupt only for supported relay providers and never exposes escape', () => {
  const supported = renderToStaticMarkup(createElement(LiveRelayComposer, { target, relayKind: 'codex' }));
  const unsupported = renderToStaticMarkup(createElement(LiveRelayComposer, {
    target,
    relayKind: 'unsupported' as never,
  }));

  assert.ok(supported.includes('Interrupt'));
  assert.ok(!supported.includes('Escape'));
  assert.ok(!unsupported.includes('Interrupt'));
});

test('relay action API posts the exact interrupt body once without retrying', async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; options?: RequestInit }> = [];
  globalThis.fetch = (async (url: string | URL | Request, options?: RequestInit) => {
    calls.push({ url: String(url), options });
    return {
      headers: { get: () => null },
      ok: false,
      json: async () => ({ error: { message: 'refused' } }),
    } as unknown as Response;
  }) as typeof fetch;

  try {
    await api.externalCliSessionAction(target.tmux, target.process, 'interrupt');
    assert.deepEqual(calls, [{
      url: '/api/providers/sessions/external/actions',
      options: {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tmux: target.tmux, process: target.process, action: 'interrupt' }),
      },
    }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('relay translations exist in every supported locale', () => {
  for (const locale of ['en', 'fr', 'ko', 'zh-CN', 'ja', 'ru', 'de', 'tr', 'it', 'zh-TW']) {
    const translation = JSON.parse(readFileSync(
      new URL(`../../../../i18n/locales/${locale}/chat.json`, import.meta.url),
      'utf8',
    )) as { relay?: Record<string, string> };
    assert.deepEqual(Object.keys(translation.relay ?? {}).sort(), [
      'interrupt',
      'interruptFailed',
      'interruptSent',
      'interrupting',
    ]);
  }
});
