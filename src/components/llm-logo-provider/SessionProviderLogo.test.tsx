import assert from 'node:assert/strict';
import test from 'node:test';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import SessionProviderLogo from './SessionProviderLogo';

test('gjc renders the distinct Gajae Code mark, not ChatMux or Claude branding', () => {
  const gjc = renderToStaticMarkup(createElement(SessionProviderLogo, { provider: 'gjc' }));
  const claude = renderToStaticMarkup(createElement(SessionProviderLogo, { provider: 'claude' }));

  assert.ok(gjc.includes('/providers/gajae-code.png'), 'gjc renders the official Gajae Code mark');
  assert.ok(gjc.includes('alt="Gajae Code"'), 'gjc mark carries its own provider label');
  assert.ok(!gjc.includes('src="/logo.png"'), 'gjc does not reuse the ChatMux product mark');
  assert.notEqual(gjc, claude, 'gjc must not render the same markup as Claude');
});

test('known providers each get their own distinct mark', () => {
  const providers = ['gjc', 'claude', 'codex', 'cursor', 'opencode', 'omp'] as const;
  const markups = providers.map((provider) =>
    renderToStaticMarkup(createElement(SessionProviderLogo, { provider })),
  );
  const unique = new Set(markups);
  assert.equal(unique.size, providers.length, 'every provider logo is unique');
});

test('Oh My Pi and OpenCode use their official provider marks', () => {
  const omp = renderToStaticMarkup(createElement(SessionProviderLogo, { provider: 'omp' }));
  const opencode = renderToStaticMarkup(createElement(SessionProviderLogo, { provider: 'opencode' }));

  assert.ok(omp.includes('viewBox="0 0 64 64"'));
  assert.ok(omp.includes('#ed4abf'));
  assert.ok(omp.includes('M14 16h36v8H40v32h-8V24h-6v22h-8V24h-4z'));
  assert.ok(opencode.includes('viewBox="0 0 300 300"'));
  assert.ok(opencode.includes('M180 240H60V120H180V240Z'));
  assert.ok(opencode.includes('#211E1E'));
});

test('className is forwarded to the gjc mark', () => {
  const html = renderToStaticMarkup(createElement(SessionProviderLogo, { provider: 'gjc', className: 'h-3 w-3' }));
  assert.ok(html.includes('h-3 w-3'));
});
