import assert from 'node:assert/strict';
import test from 'node:test';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import ExternalTranscriptViewSwitcher from './ExternalTranscriptViewSwitcher';

test('external transcript switcher exposes conversation and live CLI output views', () => {
  const html = renderToStaticMarkup(
    <ExternalTranscriptViewSwitcher
      mode="conversation"
      providerLabel="Codex CLI"
      tmuxName="test-codex"
      onChange={() => undefined}
    />,
  );

  assert.ok(html.includes('role="tablist"'));
  assert.ok(html.includes('aria-label="Codex CLI 세션 보기"'));
  assert.ok(html.includes('aria-selected="true"'));
  assert.ok(html.includes('대화'));
  assert.ok(html.includes('CLI 출력'));
  assert.ok(html.includes('test-codex'));
});

test('external transcript switcher marks CLI output as selected', () => {
  const html = renderToStaticMarkup(
    <ExternalTranscriptViewSwitcher
      mode="cli"
      providerLabel="Claude Code"
      tmuxName="claude-session"
      onChange={() => undefined}
    />,
  );

  const selected = html.match(/aria-selected="true"/g) ?? [];
  assert.equal(selected.length, 1);
  assert.match(html, /aria-selected="true"[^>]*>.*CLI 출력/);
});
