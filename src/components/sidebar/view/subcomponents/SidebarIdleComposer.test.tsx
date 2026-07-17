import assert from 'node:assert/strict';
import test from 'node:test';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import SidebarIdleComposer from './SidebarIdleComposer';

// First-message composer for '대기' (idle, pre-transcript) gjc panes. SSR
// tests pin each externally-visible state; the send/promotion flow itself is
// exercised end-to-end against a live fixture session (server send route +
// tower injection are covered by their own tests).

test('collapsed idle composer offers the first-message affordance', () => {
  const html = renderToStaticMarkup(
    createElement(SidebarIdleComposer, { tmuxName: 'flask', tmuxId: '$9' }),
  );
  assert.ok(html.includes('첫 메시지 보내기'), 'entry button is visible');
  assert.ok(!html.includes('textarea'), 'no editor until the user opens it');
});

test('composing state renders an editable textarea and a send button', () => {
  const html = renderToStaticMarkup(
    createElement(SidebarIdleComposer, {
      tmuxName: 'flask',
      tmuxId: '$9',
      initialStatus: { kind: 'composing' },
    }),
  );
  assert.ok(html.includes('textarea'), 'editor is rendered');
  assert.ok(html.includes('flask에 첫 지시'), 'placeholder names the target pane');
  assert.ok(html.includes('전송'), 'send affordance is visible');
});

test('promoting state shows the waiting notice and hides the editor', () => {
  const html = renderToStaticMarkup(
    createElement(SidebarIdleComposer, {
      tmuxName: 'flask',
      tmuxId: '$9',
      initialStatus: { kind: 'promoting' },
    }),
  );
  assert.ok(html.includes('첫 턴 시작 대기 중'), 'explains the promotion wait');
  assert.ok(!html.includes('textarea'), 'no editing while waiting for promotion');
});

test('error state fails closed back to an editable composer with the reason', () => {
  const html = renderToStaticMarkup(
    createElement(SidebarIdleComposer, {
      tmuxName: 'flask',
      tmuxId: '$9',
      initialStatus: { kind: 'error', text: '관제탑 미가동 — 전송 불가' },
    }),
  );
  assert.ok(html.includes('관제탑 미가동'), 'shows the failure reason');
  assert.ok(html.includes('textarea'), 'the composer stays editable for retry');
});
