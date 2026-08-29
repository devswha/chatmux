import assert from 'node:assert/strict';
import test from 'node:test';

import type { TFunction } from 'i18next';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ThemeProvider } from '../contexts/ThemeContext';

import { AuthProvider } from './auth';
import SidebarHeader from './sidebar/view/subcomponents/SidebarHeader';
import Settings from './settings/view/Settings';

const noop = () => {};

test('settings surface exposes a labelled modal dialog', () => {
  const storage = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
      clear: () => storage.clear(),
      key: () => null,
      length: 0,
    } satisfies Storage,
  });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      matchMedia: () => ({ matches: false }),
    },
  });

  const settingsHtml = renderToStaticMarkup(
    createElement(ThemeProvider, null, createElement(AuthProvider, null, createElement(Settings, {
      isOpen: true,
      onClose: noop,
    }))),
  );
  assert.match(settingsHtml, /role="dialog"/);
  assert.match(settingsHtml, /aria-modal="true"/);
  assert.match(settingsHtml, /aria-labelledby="settings-dialog-title"/);
  assert.match(settingsHtml, /aria-label="(?:Close|common:buttons\.close)"/);
});

test('mobile sidebar icon buttons have translated accessible names', () => {
  const translations: Record<string, string> = {
    'tooltips.refresh': 'Refresh projects and sessions',
  };
  const t = ((key: string, fallback?: string) => translations[key] ?? fallback ?? key) as TFunction;
  const html = renderToStaticMarkup(createElement(SidebarHeader, {
    isPWA: false,
    isMobile: true,
    onRefresh: noop,
    isRefreshing: false,
    onCollapseSidebar: noop,
    t,
  }));

  assert.match(html, /aria-label="Refresh projects and sessions"/);
});
