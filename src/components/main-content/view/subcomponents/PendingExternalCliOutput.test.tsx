import assert from 'node:assert/strict';
import test from 'node:test';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import PendingExternalCliOutput from './PendingExternalCliOutput';

test('pending external CLI output exposes interactive terminal prompts', () => {
  const html = renderToStaticMarkup(
    <PendingExternalCliOutput providerLabel="Codex" output="Do you trust this folder?\n1. Yes" />,
  );

  assert.ok(html.includes('aria-label="Codex live terminal output"'));
  assert.ok(html.includes('Do you trust this folder?'));
  assert.ok(html.includes('1. Yes'));
});

test('pending external CLI output renders tmux ANSI colors without exposing escape bytes', () => {
  const html = renderToStaticMarkup(
    <PendingExternalCliOutput
      providerLabel="Oh My Pi"
      output={'\u001b[31mRed\u001b[0m \u001b[38;5;33mBlue\u001b[48;2;1;2;3m RGB\u001b[0m'}
    />,
  );

  assert.ok(html.includes('style="color:#cd3131"'));
  assert.ok(html.includes('style="color:#0087ff"'));
  assert.ok(html.includes('background-color:#010203'));
  assert.ok(!html.includes('\u001b'));
  assert.ok(html.includes('whitespace-pre'));
});

test('pending external CLI output keeps the transcript guidance before pane output arrives', () => {
  const html = renderToStaticMarkup(
    <PendingExternalCliOutput providerLabel="Claude" output="" />,
  );

  assert.ok(html.includes('Claude transcript'));
});
