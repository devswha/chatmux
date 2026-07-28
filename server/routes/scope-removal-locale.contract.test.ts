import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const languages = ['de', 'en', 'fr', 'it', 'ja', 'ko', 'ru', 'tr', 'zh-CN', 'zh-TW'] as const;
const root = new URL('../../', import.meta.url);
const baseline = JSON.parse(readFileSync(new URL('artifacts/scope-removal-baseline.json', root), 'utf8'));
const readLocale = (language: string, namespace: string) =>
  JSON.parse(readFileSync(new URL(`src/i18n/locales/${language}/${namespace}.json`, root), 'utf8'));
const has = (value: unknown, path: string) => path.split('.').every((key) => {
  if (!value || typeof value !== 'object' || !Object.hasOwn(value, key)) return false;
  value = (value as Record<string, unknown>)[key];
  return true;
});

test('baseline locks the exact P1, P3, P5, and P8 locale accounting', () => {
  const rows = baseline.localePresence as Record<string, Record<string, boolean>>;
  assert.equal(languages.filter((language) => rows[language]['chat.tasks.nextTaskPrompt']).length, 9);
  assert.equal(rows.ja['chat.tasks.nextTaskPrompt'], false);
  for (const path of ['common.fileTree', 'common.tabs.files', 'sidebar.navigation.files', 'common.tabs.git', 'sidebar.navigation.git', 'common.tabs.tasks', 'sidebar.navigation.tasks', 'common.tabs.browser']) {
    assert.equal(languages.filter((language) => rows[language][path]).length, 10, path);
  }
  assert.deepEqual(languages.filter((language) => rows[language]['common.filesPanel']), ['en', 'ko']);
});

test('all exact candidate locale paths are absent after their originating cuts', () => {
  for (const language of languages) {
    const common = readLocale(language, 'common');
    const sidebar = readLocale(language, 'sidebar');
    const chat = readLocale(language, 'chat');
    const settings = readLocale(language, 'settings');

    for (const path of ['fileTree', 'filesPanel', 'tabs.files', 'tabs.git', 'tabs.tasks', 'tabs.browser']) {
      assert.equal(has(common, path), false, `${language}:common.${path}`);
    }
    for (const path of [
      'navigation',
      'projects',
      'sessions',
      'search',
      'deleteConfirmation',
      'tabs',
    ]) {
      assert.equal(has(sidebar, path), false, `${language}:sidebar.${path}`);
    }
    assert.equal(has(chat, 'tasks.nextTaskPrompt'), false, `${language}:chat.tasks.nextTaskPrompt`);
    assert.equal(has(settings, 'mcp'), false, `${language}:settings.mcp`);
  }
});

test('generic browser, file, chat, and active sidebar siblings remain', () => {
  for (const language of languages) {
    const common = readLocale(language, 'common');
    const sidebar = readLocale(language, 'sidebar');
    const settings = readLocale(language, 'settings');
    assert.equal(has(common, 'tabs.chat'), true, `${language}:common.tabs.chat`);
    assert.equal(has(common, 'tabs.computer'), true, `${language}:common.tabs.computer`);
    assert.equal(has(common, 'mainContent.projectFiles'), true, `${language}:common.mainContent.projectFiles`);
    assert.equal(has(sidebar, 'actions.settings'), true, `${language}:sidebar.actions.settings`);
    assert.equal(has(sidebar, 'newSessionForm.open'), true, `${language}:sidebar.newSessionForm.open`);
    assert.equal(has(settings, 'appearanceSettings.installApp.browserMenuHint'), true, `${language}:settings.appearanceSettings.installApp.browserMenuHint`);
  }
});
