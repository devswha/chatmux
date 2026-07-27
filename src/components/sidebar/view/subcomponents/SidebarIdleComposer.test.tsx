import assert from 'node:assert/strict';
import test from 'node:test';

import i18next from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import koSidebar from '../../../../i18n/locales/ko/sidebar.json';
import type { TmuxPaneTarget } from '../../../../../shared/tmux';

const target: TmuxPaneTarget = {
  tmux: { socketPath: '/tmp/chatmux.sock', sessionId: 'session-1', windowId: '@1', paneId: '%9' },
  process: { pid: 909, startedAtMs: 1_700_000_000_909 },
};
import SidebarIdleComposer from './SidebarIdleComposer';

// First-message composer for '대기' (idle, pre-transcript) gjc panes. SSR
// tests pin each externally-visible state; the send/promotion flow itself is
// exercised end-to-end against a live fixture session (server send route +
// tower injection are covered by their own tests). Rendering uses the ko
// locale so assertions stay pinned to the shipped translations.
const renderComposer = async (props: React.ComponentProps<typeof SidebarIdleComposer>) => {
  const instance = i18next.createInstance();
  await instance.init({
    lng: 'ko',
    fallbackLng: false,
    resources: { ko: { sidebar: koSidebar } },
    ns: ['sidebar'],
    defaultNS: 'sidebar',
    interpolation: { escapeValue: false },
  });
  return renderToStaticMarkup(
    createElement(
      I18nextProvider,
      { i18n: instance },
      createElement(SidebarIdleComposer, props),
    ),
  );
};

test('collapsed idle composer offers the first-message affordance', async () => {
  const html = await renderComposer({ tmuxName: 'flask', target });
  assert.ok(html.includes('첫 메시지 보내기'), 'entry button is visible');
  assert.ok(!html.includes('textarea'), 'no editor until the user opens it');
});

test('composing state renders an editable textarea and a send button', async () => {
  const html = await renderComposer({
    tmuxName: 'flask',
    target,
    initialStatus: { kind: 'composing' },
  });
  assert.ok(html.includes('textarea'), 'editor is rendered');
  assert.ok(html.includes('flask에 첫 지시'), 'placeholder names the target pane');
  assert.ok(html.includes('전송'), 'send affordance is visible');
});

test('promoting state shows the waiting notice and hides the editor', async () => {
  const html = await renderComposer({
    tmuxName: 'flask',
    target,
    initialStatus: { kind: 'promoting' },
  });
  assert.ok(html.includes('첫 턴 시작 대기 중'), 'explains the promotion wait');
  assert.ok(!html.includes('textarea'), 'no editing while waiting for promotion');
});

test('error state fails closed back to an editable composer with the reason', async () => {
  const html = await renderComposer({
    tmuxName: 'flask',
    target,
    initialStatus: { kind: 'error', text: '관제탑 미가동 — 전송 불가' },
  });
  assert.ok(html.includes('관제탑 미가동'), 'shows the failure reason');
  assert.ok(html.includes('textarea'), 'the composer stays editable for retry');
});
