import assert from 'node:assert/strict';
import test from 'node:test';

import type { TFunction } from 'i18next';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ThemeProvider } from '../contexts/ThemeContext';

import ProjectCreationWizard from './project-creation-wizard/ProjectCreationWizard';
import SidebarHeader from './sidebar/view/subcomponents/SidebarHeader';
import Settings from './settings/view/Settings';

const noop = () => {};

test('settings and project creation surfaces expose labelled modal dialogs', () => {
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
    createElement(ThemeProvider, null, createElement(Settings, {
      isOpen: true,
      onClose: noop,
    })),
  );
  assert.match(settingsHtml, /role="dialog"/);
  assert.match(settingsHtml, /aria-modal="true"/);
  assert.match(settingsHtml, /aria-labelledby="settings-dialog-title"/);
  assert.match(settingsHtml, /aria-label="(?:Close|common:buttons\.close)"/);

  const projectHtml = renderToStaticMarkup(createElement(ProjectCreationWizard, {
    onClose: noop,
  }));
  assert.match(projectHtml, /role="dialog"/);
  assert.match(projectHtml, /aria-modal="true"/);
  assert.match(projectHtml, /aria-labelledby="project-creation-dialog-title"/);
  assert.match(projectHtml, /aria-label="(?:Close|buttons\.close)"/);
});

test('mobile sidebar icon buttons have translated accessible names', () => {
  const translations: Record<string, string> = {
    'tooltips.refresh': 'Refresh projects and sessions',
    'tooltips.createProject': 'Create new project',
  };
  const t = ((key: string, fallback?: string) => translations[key] ?? fallback ?? key) as TFunction;
  const html = renderToStaticMarkup(createElement(SidebarHeader, {
    isPWA: false,
    isMobile: true,
    isLoading: false,
    projectsCount: 0,
    runningSessionsCount: 0,
    archivedSessionsCount: 0,
    isArchivedSessionsLoading: false,
    searchFilter: '',
    onSearchFilterChange: noop,
    onClearSearchFilter: noop,
    searchMode: 'projects',
    onSearchModeChange: noop,
    onRefresh: noop,
    isRefreshing: false,
    onCreateProject: noop,
    onCollapseSidebar: noop,
    t,
  }));

  assert.match(html, /aria-label="Refresh projects and sessions"/);
  assert.match(html, /aria-label="Create new project"/);
});
