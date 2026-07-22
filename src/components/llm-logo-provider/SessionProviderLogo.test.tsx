import assert from 'node:assert/strict';
import test from 'node:test';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import SessionProviderLogo from './SessionProviderLogo';

test('gjc renders the distinct ChatMux mark, not the reused Claude logo', () => {
  const gjc = renderToStaticMarkup(createElement(SessionProviderLogo, { provider: 'gjc' }));
  const claude = renderToStaticMarkup(createElement(SessionProviderLogo, { provider: 'claude' }));

  assert.ok(gjc.includes('/logo.png'), 'gjc renders the ChatMux product mark');
  assert.ok(gjc.includes('ChatMux Code'), 'gjc mark carries the provider label');
  assert.notEqual(gjc, claude, 'gjc must not render the same markup as Claude');
});

test('known providers each get their own distinct mark', () => {
  const providers = ['gjc', 'claude', 'codex', 'cursor', 'opencode'] as const;
  const markups = providers.map((provider) =>
    renderToStaticMarkup(createElement(SessionProviderLogo, { provider })),
  );
  const unique = new Set(markups);
  assert.equal(unique.size, providers.length, 'every provider logo is unique');
});

test('className is forwarded to the gjc mark', () => {
  const html = renderToStaticMarkup(createElement(SessionProviderLogo, { provider: 'gjc', className: 'h-3 w-3' }));
  assert.ok(html.includes('h-3 w-3'));
});
