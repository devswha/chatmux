import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';

import i18next from 'i18next';
import { createElement } from 'react';
import { I18nextProvider } from 'react-i18next';
import { renderToStaticMarkup } from 'react-dom/server';

import deSidebar from '../../../../i18n/locales/de/sidebar.json';
import enSidebar from '../../../../i18n/locales/en/sidebar.json';
import frSidebar from '../../../../i18n/locales/fr/sidebar.json';
import itSidebar from '../../../../i18n/locales/it/sidebar.json';
import jaSidebar from '../../../../i18n/locales/ja/sidebar.json';
import koSidebar from '../../../../i18n/locales/ko/sidebar.json';
import ruSidebar from '../../../../i18n/locales/ru/sidebar.json';
import trSidebar from '../../../../i18n/locales/tr/sidebar.json';
import zhCNSidebar from '../../../../i18n/locales/zh-CN/sidebar.json';
import zhTWSidebar from '../../../../i18n/locales/zh-TW/sidebar.json';

import SidebarNewSession from './SidebarNewSession';

const localeResources = {
  de: deSidebar,
  en: enSidebar,
  fr: frSidebar,
  it: itSidebar,
  ja: jaSidebar,
  ko: koSidebar,
  ru: ruSidebar,
  tr: trSidebar,
  'zh-CN': zhCNSidebar,
  'zh-TW': zhTWSidebar,
};

const requiredKeys = [
  'open',
  'sessionNamePlaceholder',
  'workingDirectoryPlaceholder',
  'cancel',
  'creating',
  'create',
  'errors.towerUnavailable',
  'errors.nameConflict',
  'errors.createFailed',
];
const externalSessionRequiredKeys = [
  'viewInTerminal',
  'openConversation',
  'closeSessionTitle',
  'closeSessionConfirm',
  'closeSession',
  'stopFailed',
  'stopping',
  'cancel',
  'activity.running',
  'activity.waitingUser',
  'activity.waitingUserTitle',
  'activity.approvalPending',
  'activity.approvalPendingAttach',
  'activity.approvalPendingTitle',
  'activity.unknown',
  'activity.unknownTitle',
];

const readPath = (value: unknown, keyPath: string): unknown => (
  keyPath.split('.').reduce<unknown>((current, segment) => (
    current && typeof current === 'object'
      ? (current as Record<string, unknown>)[segment]
      : undefined
  ), value)
);

test('all supported sidebar locales define the complete new-session form', () => {
  for (const [locale, resource] of Object.entries(localeResources)) {
    for (const key of requiredKeys) {
      const value = readPath(resource.newSessionForm, key);
      assert.equal(typeof value, 'string', `${locale} is missing newSessionForm.${key}`);
      assert.notEqual(value, '', `${locale} has an empty newSessionForm.${key}`);
    }
  }
});
test('all supported sidebar locales define external-session copy consumed by SidebarExternalSection', () => {
  for (const [locale, resource] of Object.entries(localeResources)) {
    for (const key of externalSessionRequiredKeys) {
      const value = readPath(resource.externalSessions, key);
      assert.equal(typeof value, 'string', `${locale} is missing externalSessions.${key}`);
      assert.notEqual(value, '', `${locale} has an empty externalSessions.${key}`);
    }
  }
});

const renderForm = async (locale: 'en' | 'ko') => {
  const instance = i18next.createInstance();
  await instance.init({
    lng: locale,
    fallbackLng: false,
    resources: {
      [locale]: { sidebar: localeResources[locale] },
    },
    ns: ['sidebar'],
    defaultNS: 'sidebar',
    interpolation: { escapeValue: false },
  });

  return renderToStaticMarkup(
    createElement(
      I18nextProvider,
      { i18n: instance },
      createElement(SidebarNewSession, { onCreated: () => {}, initiallyOpen: true }),
    ),
  );
};

test('English and Korean render the new-session form without mixed-language copy', async () => {
  const english = await renderForm('en');
  assert.ok(english.includes(enSidebar.newSessionForm.sessionNamePlaceholder));
  assert.ok(english.includes(enSidebar.newSessionForm.workingDirectoryPlaceholder));
  assert.ok(english.includes(enSidebar.newSessionForm.cancel));
  assert.ok(english.includes(enSidebar.newSessionForm.create));
  assert.ok(!english.includes(koSidebar.newSessionForm.sessionNamePlaceholder));
  assert.ok(!english.includes(koSidebar.newSessionForm.cancel));

  const korean = await renderForm('ko');
  assert.ok(korean.includes(koSidebar.newSessionForm.sessionNamePlaceholder));
  assert.ok(korean.includes(koSidebar.newSessionForm.workingDirectoryPlaceholder));
  assert.ok(korean.includes(koSidebar.newSessionForm.cancel));
  assert.ok(korean.includes(koSidebar.newSessionForm.create));
  assert.ok(!korean.includes(enSidebar.newSessionForm.sessionNamePlaceholder));
  assert.ok(!korean.includes(enSidebar.newSessionForm.cancel));
});

test('successful GJC and external spawns both refresh discovery', () => {
  const source = readFileSync(new URL('./SidebarNewSession.tsx', import.meta.url), 'utf8');
  const completion = source.slice(
    source.indexOf('const completeSpawn'),
    source.indexOf('const spawn'),
  );
  assert.match(completion, /onCreated\(\)/);

  const gjcBranch = source.slice(
    source.indexOf("if (provider === 'gjc')"),
    source.indexOf('const response = await api.externalCliSessionSpawn'),
  );
  assert.match(gjcBranch, /completeSpawn\(trimmedCwd\)/);

  const externalStart = source.indexOf('const response = await api.externalCliSessionSpawn');
  const externalBranch = source.slice(
    externalStart,
    source.indexOf('} catch {', externalStart),
  );
  assert.match(externalBranch, /completeSpawn\(trimmedCwd\)/);
});

test('Codex update-required responses use the localized warning', () => {
  const source = readFileSync(new URL('./SidebarNewSession.tsx', import.meta.url), 'utf8');
  assert.match(source, /CODEX_UPDATE_REQUIRED/);
  assert.match(source, /newSessionForm\.errors\.codexUpdateRequired/);
});
