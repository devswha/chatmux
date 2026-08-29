import assert from 'node:assert/strict';
import test from 'node:test';

import { createElement } from 'react';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import TestRenderer, { act } from 'react-test-renderer';

import { commonI18n } from '../mountedBrowserEnvironment';

import HostNotFound from './HostNotFound';

async function renderSurface() {
  const i18n = await commonI18n();
  return TestRenderer.create(
    createElement(
      I18nextProvider,
      { i18n },
      createElement(
        MemoryRouter,
        { initialEntries: ['/missing'] },
        createElement(
          Routes,
          null,
          createElement(Route, {
            path: '/missing',
            element: createElement(HostNotFound, { requestedHostId: 'not-a-host' }),
          }),
          createElement(Route, {
            path: '/',
            element: createElement('output', { 'data-testid': 'home-route' }, 'home'),
          }),
        ),
      ),
    ),
  );
}

test('Given an unknown host, when the recovery surface mounts, then it exposes one styled link', async () => {
  // Given
  const renderer = await renderSurface();

  // When
  const links = renderer.root.findAllByType('a');

  // Then
  assert.equal(links.length, 1);
  assert.equal(renderer.root.findAllByType('button').length, 0);
  assert.match(links[0]?.props.className ?? '', /border/);
  assert.match(links[0]?.props.className ?? '', /w-full/);
  renderer.unmount();
});

test('Given an unknown host, when the recovery link is clicked, then it navigates home', async () => {
  // Given
  const renderer = await renderSurface();
  const link = renderer.root.findByType('a');

  // When
  await act(async () => {
    link.props.onClick({ button: 0, preventDefault: () => undefined });
  });

  // Then
  assert.equal(renderer.root.findByProps({ 'data-testid': 'home-route' }).children.join(''), 'home');
  renderer.unmount();
});
