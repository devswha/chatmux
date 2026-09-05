import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';

import i18next from 'i18next';
import { I18nextProvider } from 'react-i18next';
import TestRenderer, { act } from 'react-test-renderer';

import type { DiscoveryFreshness } from '../../../../hooks/useDiscoveryStream';

import SidebarHeader from './SidebarHeader';

const localesRoot = new URL('../../../../i18n/locales/', import.meta.url);
const states: DiscoveryFreshness[] = ['reconnecting', 'refreshing', 'current', 'unavailable'];

for (const locale of readdirSync(localesRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
  test(`${locale.name} header exposes one polite local discovery status on mobile and desktop`, async (t) => {
    const common = JSON.parse(readFileSync(new URL(`${locale.name}/common.json`, localesRoot), 'utf8'));
    const sidebar = JSON.parse(readFileSync(new URL(`${locale.name}/sidebar.json`, localesRoot), 'utf8'));
    const i18n = i18next.createInstance();
    await i18n.init({ lng: locale.name, fallbackLng: false, resources: { [locale.name]: { common, sidebar } } });
    let refreshes = 0;
    let collapses = 0;
    const element = (discoveryFreshness: DiscoveryFreshness, isMobile: boolean) => (
      <I18nextProvider i18n={i18n}>
        <SidebarHeader
          discoveryFreshness={discoveryFreshness}
          isPWA={false}
          isMobile={isMobile}
          onRefresh={() => { refreshes += 1; }}
          isRefreshing={false}
          onCollapseSidebar={() => { collapses += 1; }}
          t={i18n.getFixedT(locale.name, 'sidebar')}
        />
      </I18nextProvider>
    );
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => { renderer = TestRenderer.create(element('reconnecting', false)); });
    t.after(() => act(() => renderer.unmount()));
    const status = renderer.root.findByProps({ role: 'status' });
    for (const mobile of [false, true]) {
      for (const state of states) {
        await act(async () => renderer.update(element(state, mobile)));
        const label = common.discoveryFreshness[state];
        assert.equal(typeof label, 'string');
        assert.ok(label.trim().length > 0);
        assert.equal(renderer.root.findAllByProps({ role: 'status' }).length, 1);
        assert.equal(renderer.root.findByProps({ role: 'status' }), status);
        assert.equal(status.props['aria-live'], 'polite');
        assert.equal(status.props['aria-atomic'], 'true');
        assert.doesNotMatch(status.props.className, /\bhidden\b/);
        assert.ok(status.findAllByType('span').some((span) => span.children.includes(label)));
        assert.equal(status.findAllByType('button').length, 0);
        assert.equal(renderer.root.findAllByProps({ role: 'alert' }).length, 0);
      }
    }
    assert.equal(refreshes, 0);
    assert.equal(collapses, 0);
    assert.equal(new Set(states.map((state) => common.discoveryFreshness[state])).size, states.length);
    if (locale.name === 'en') {
      assert.ok(states.every((state) => /local session list/i.test(common.discoveryFreshness[state])));
    }
  });
}
