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

test('pending external CLI output keeps the transcript guidance before pane output arrives', () => {
  const html = renderToStaticMarkup(
    <PendingExternalCliOutput providerLabel="Claude" output="" />,
  );

  assert.ok(html.includes('Claude transcript'));
});
