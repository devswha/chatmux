import assert from 'node:assert/strict';
import test from 'node:test';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import '../../../../i18n/config';

import { api } from '../../../../utils/api';
import type { TmuxPaneTarget } from '../../../../../shared/tmux';
import {
  buildPlainTextInsertion,
  filterMentionableFiles,
  flattenProjectFileTree,
  getActiveMentionToken,
  isRelayImagePathAllowed,
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
  assert.ok(html.includes('Message chatmux2…'));
  assert.ok(html.includes('role="separator"'));
  assert.ok(html.includes('Drag to resize the message input'));
  assert.ok(!html.includes('$117'));
  assert.ok(!html.includes('%123'));
});

test('LiveRelayComposer uses a neutral label when no tmux name is available', () => {
  const html = renderToStaticMarkup(createElement(LiveRelayComposer, { target }));

  assert.ok(html.includes('current session'));
  assert.ok(!html.includes('$117'));
  assert.ok(!html.includes('%123'));
});

test('LiveRelayComposer asks for a number while a transcript choice is pending', () => {
  const html = renderToStaticMarkup(createElement(LiveRelayComposer, {
    target,
    relayKind: 'codex',
    transcriptSessionId: 'app-session-1',
    pendingAsk: { toolId: 'ask-1', maxChoiceNumber: 4 },
  }));
  assert.ok(html.includes('Enter a choice number (0-4)'));
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
test('LiveRelayComposer offers stop only while a supported provider is processing', () => {
  const idle = renderToStaticMarkup(createElement(LiveRelayComposer, { target, relayKind: 'codex' }));
  const processing = renderToStaticMarkup(createElement(LiveRelayComposer, {
    target,
    relayKind: 'codex',
    isProcessing: true,
  }));
  const unsupported = renderToStaticMarkup(createElement(LiveRelayComposer, {
    target,
    relayKind: 'unsupported' as never,
    isProcessing: true,
  }));

  assert.ok(!idle.includes('aria-label="Stop"'), 'an idle session never exposes an interrupt path');
  assert.ok(processing.includes('aria-label="Stop"'), 'a running turn turns the submit control into stop');
  assert.ok(!unsupported.includes('aria-label="Stop"'), 'unsupported providers never expose stop');
  assert.ok(!processing.includes('Escape'));
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

test('B10: relay image paths from the shared asset store or the active workspace are allowed, everything else is rejected', () => {
  assert.equal(isRelayImagePathAllowed('/home/user/.chatmux/assets/123-photo.png', null), true);
  assert.equal(isRelayImagePathAllowed('/home/user/.chatmux/assets/123-photo.png', '/workspace/other'), true);
  assert.equal(isRelayImagePathAllowed('/workspace/project/docs/photo.png', '/workspace/project'), true);
  assert.equal(isRelayImagePathAllowed('/workspace/project', '/workspace/project'), true);

  // Outside both the asset store and the workspace.
  assert.equal(isRelayImagePathAllowed('/etc/passwd', '/workspace/project'), false);
  assert.equal(isRelayImagePathAllowed('/etc/passwd', null), false);
  // A workspace-looking prefix that is actually a sibling directory must not
  // pass a naive startsWith check.
  assert.equal(isRelayImagePathAllowed('/workspace/project-evil/photo.png', '/workspace/project'), false);
  // Traversal and non-absolute values are always rejected.
  assert.equal(isRelayImagePathAllowed('/workspace/project/../secrets/key.png', '/workspace/project'), false);
  assert.equal(isRelayImagePathAllowed('relative/photo.png', '/workspace/project'), false);
});

test('B10: plain-text path insertion adds spacing only where the surrounding text needs it', () => {
  assert.deepEqual(
    buildPlainTextInsertion('', '', '/home/user/.chatmux/assets/1-a.png'),
    { text: '/home/user/.chatmux/assets/1-a.png', caretOffset: 34 },
  );
  assert.deepEqual(
    buildPlainTextInsertion('see', 'please', '/a.png'),
    { text: 'see /a.png please', caretOffset: 11 },
  );
  assert.deepEqual(
    buildPlainTextInsertion('already ', '', '/a.png'),
    { text: 'already /a.png', caretOffset: 14 },
  );
});

test('B10: the composer uploads pasted/dropped images through the existing global asset store endpoint exactly once', async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; hasFormBody: boolean }> = [];
  globalThis.fetch = (async (url: string | URL | Request, options?: RequestInit) => {
    calls.push({ url: String(url), hasFormBody: options?.body instanceof FormData });
    return {
      headers: { get: () => null },
      ok: true,
      json: async () => ({ images: [{ name: 'a.png', path: '/home/user/.chatmux/assets/1-a.png' }] }),
    } as unknown as Response;
  }) as typeof fetch;

  try {
    const file = new File(['fake'], 'a.png', { type: 'image/png' });
    await api.uploadImageAssets([file]);
    assert.deepEqual(calls, [{ url: '/api/assets/images', hasFormBody: true }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
