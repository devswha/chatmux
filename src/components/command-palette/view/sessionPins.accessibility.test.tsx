import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';

import i18next from 'i18next';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';

import { LOCAL_HOST_ID as LOCAL, PEER_A_HOST_ID as PEER, peerDescriptor } from '../../../fleet/discovery/hostCatalog.testSupport';
import type { FleetHostEntry } from '../../../fleet/discovery/hostCatalog';
import { Command, CommandList } from '../../../shared/view/ui';
import MainContentHeader from '../../main-content/view/subcomponents/MainContentHeader';
import MainContentStateView from '../../main-content/view/subcomponents/MainContentStateView';
import type { PinInventory } from '../pins/pinnedSessionInventory';
import type { PinnedSession } from '../pins/pinnedSessions';

import PinnedSessionGroup from './PinnedSessionGroup';
import SessionPinButton from './SessionPinButton';

const localeRoot = new URL('../../../i18n/locales/', import.meta.url);
function common(locale: string) {
  return JSON.parse(readFileSync(new URL(`${locale}/common.json`, localeRoot), 'utf8'));
}
async function translated(element: ReactElement, locale = 'en') {
  const i18n = i18next.createInstance();
  await i18n.init({ lng: locale, fallbackLng: false, resources: { [locale]: { common: common(locale) } }, interpolation: { escapeValue: false } });
  return <I18nextProvider i18n={i18n}>{element}</I18nextProvider>;
}
const noop = () => {};
const project = { projectId: 'project', fullPath: '', displayName: 'Project', sessions: [{ id: 'session', title: 'Local label' }] };

for (const isMobile of [true, false]) {
  test(`${isMobile ? 'mobile' : 'desktop'} main and empty headers expose a labelled touch-sized palette launcher`, async () => {
    for (const header of [
      <MainContentHeader key="main" activeTab="chat" setActiveTab={noop} selectedProject={project} selectedSession={project.sessions[0]} isMobile={isMobile} onMenuClick={noop} />,
      <MainContentStateView key="empty" mode="empty" isMobile={isMobile} onMenuClick={noop} />,
    ]) {
      const html = renderToStaticMarkup(await translated(header));
      const button = html.match(/<button[^>]*aria-label="Search and pinned sessions"[^>]*>/)?.[0];
      assert.ok(button);
      assert.match(button, /aria-haspopup="dialog"/);
      assert.match(button, /h-11 w-11/);
      assert.match(button, /focus-visible:ring-2/);
      assert.doesNotMatch(button, /hidden|disabled|tabindex="-1"/);
    }
  });
}

test('pins form a separate host-labelled group and revoked rows lose labels while remaining removable', async () => {
  const entry: FleetHostEntry = {
    descriptor: peerDescriptor(PEER, 'Peer'), sync: 'synced', epoch: 'one', revision: 1, truncated: false,
    rows: { projects: [{ localId: 'project', displayName: 'Project' }], sessions: [{ localId: 'session', projectLocalId: 'project', summary: 'Peer private label', provider: 'codex', lastActivityMs: 1 }], panes: [] },
  };
  const pins: PinnedSession[] = [LOCAL, PEER].map((hostId) => ({ hostId, projectId: 'project', sessionId: 'session' }));
  const render = async (host: FleetHostEntry) => {
    const inventory: PinInventory = { projects: [project], catalog: { localHostId: LOCAL, hosts: new Map([[PEER, host]]) } };
    return renderToStaticMarkup(await translated(<Command><CommandList><PinnedSessionGroup pins={pins} inventory={inventory} onOpen={noop} onUnpin={noop} /></CommandList></Command>));
  };
  const html = await render(entry);
  assert.match(html, /Pinned sessions/);
  assert.match(html, /Local label/);
  assert.match(html, /Peer private label/);
  assert.ok(html.includes(LOCAL) && html.includes(PEER));
  assert.equal((html.match(/role="option"/g) ?? []).length, 2);
  for (const option of html.matchAll(/role="option"[^>]*>([\s\S]*?)<\/div>/g)) assert.doesNotMatch(option[1], /<button/);
  const revoked = await render({ ...entry, descriptor: { ...entry.descriptor, state: 'revoked' } });
  assert.doesNotMatch(revoked, /Peer private label/);
  assert.match(revoked, /aria-disabled="true"/);
  assert.match(revoked, /Unpin Session unavailable/);
  assert.doesNotMatch(revoked, /<button[^>]*disabled=/);
});

test('all shipped locales provide scoped pin labels with identical interpolation fields', async () => {
  const baseline = common('en').sessionPins as Record<string, string>;
  const placeholders = (value: string) => [...value.matchAll(/{{(\w+)}}/g)].map((match) => match[1]).sort();
  for (const entry of readdirSync(localeRoot, { withFileTypes: true }).filter((item) => item.isDirectory())) {
    const labels = common(entry.name).sessionPins as Record<string, string>;
    assert.deepEqual(Object.keys(labels).sort(), Object.keys(baseline).sort(), entry.name);
    for (const key of Object.keys(baseline)) {
      assert.ok(labels[key]?.trim(), `${entry.name}: ${key}`);
      assert.deepEqual(placeholders(labels[key]), placeholders(baseline[key]));
    }
    const html = renderToStaticMarkup(await translated(<SessionPinButton pinned={false} name="Session" onToggle={noop} />, entry.name));
    assert.doesNotMatch(html, /sessionPins\./);
  }
});
