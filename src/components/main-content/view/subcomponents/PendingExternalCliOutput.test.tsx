import assert from 'node:assert/strict';
import test from 'node:test';

import React from 'react';
import i18next from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { renderToStaticMarkup } from 'react-dom/server';

import enChat from '../../../../i18n/locales/en/chat.json';

import PendingExternalCliOutput, {
  fitTerminalFontSize,
} from './PendingExternalCliOutput';

// The component resolves its default empty-state guidance through i18n;
// render with the en chat resources so assertions pin the shipped translation.
const renderWithI18n = async (element: React.ReactElement) => {
  const instance = i18next.createInstance();
  await instance.init({
    lng: 'en',
    fallbackLng: false,
    resources: { en: { chat: enChat } },
    ns: ['chat'],
    defaultNS: 'chat',
    interpolation: { escapeValue: false },
  });
  return renderToStaticMarkup(
    <I18nextProvider i18n={instance}>{element}</I18nextProvider>,
  );
};

test('pending external CLI output exposes interactive terminal prompts', async () => {
  const html = await renderWithI18n(
    <PendingExternalCliOutput providerLabel="Codex" output="Do you trust this folder?\n1. Yes" />,
  );

  assert.ok(html.includes('aria-label="Codex live terminal output"'));
  assert.ok(html.includes('Do you trust this folder?'));
  assert.ok(html.includes('1. Yes'));
});

test('pending external CLI output renders tmux ANSI colors without exposing escape bytes', async () => {
  const html = await renderWithI18n(
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

test('pending external CLI output scales every tmux column inside a phone viewport', () => {
  const fontSize = fitTerminalFontSize(320, 200);

  assert.equal(fontSize, 2.25);
  assert.ok(200 * fontSize * 0.64 <= 320 - 32);
  assert.equal(fitTerminalFontSize(1024, 80), 12);
});

test('pending external CLI output keeps the transcript guidance before pane output arrives', async () => {
  const html = await renderWithI18n(
    <PendingExternalCliOutput providerLabel="Claude" output="" />,
  );

  assert.ok(html.includes('Claude transcript'));
});
