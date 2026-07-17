import assert from 'node:assert/strict';
import test from 'node:test';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { hasServerRebooted, VersionUpgradeModal } from './VersionUpgradeModal';

const baseProps = {
  isOpen: true,
  onClose: () => {},
  releaseInfo: null,
  currentVersion: '1.0.0',
  latestVersion: '1.1.0',
};

// The success signal for a self-update is the server answering as a NEW
// process — version alone cannot tell (a source update may not bump it).
test('hasServerRebooted: only a present, different bootId counts', () => {
  assert.equal(hasServerRebooted('boot-a', { bootId: 'boot-b' }), true);
  assert.equal(hasServerRebooted('boot-a', { bootId: 'boot-a' }), false, 'same process still answering');
  assert.equal(hasServerRebooted('boot-a', {}), false, 'a health payload without bootId proves nothing');
  assert.equal(hasServerRebooted('boot-a', null), false);
  assert.equal(hasServerRebooted(null, { bootId: 'boot-b' }), false, 'no baseline captured — never claim success');
  assert.equal(hasServerRebooted('boot-a', { bootId: '' }), false);
});

// SSR renders without an initialized i18n instance, so t() may emit the raw
// key ('versionUpdate.buttons.updateNow') instead of a translation — match both.
const UPDATE_NOW = /Update Now|지금 업데이트|buttons\.updateNow/;

test('source install offers one-click update and the copyable command', () => {
  const html = renderToStaticMarkup(
    createElement(VersionUpgradeModal, { ...baseProps, installMode: 'source' }),
  );
  assert.ok(html.includes('git pull --ff-only'), 'manual command shown for source installs');
  assert.ok(UPDATE_NOW.test(html), 'one-click entry is offered');
});

test('release install fails closed to the manual checksum-verified cutover', () => {
  const html = renderToStaticMarkup(
    createElement(VersionUpgradeModal, { ...baseProps, installMode: 'release' }),
  );
  assert.ok(html.includes('SELF-HOST.md'), 'points at the documented cutover');
  assert.ok(!UPDATE_NOW.test(html), 'no one-click button');
  assert.ok(!html.includes('git pull --ff-only'), 'no source-checkout command for artifact installs');
});

test('unknown install mode shows the manual path but no one-click button', () => {
  const html = renderToStaticMarkup(
    createElement(VersionUpgradeModal, { ...baseProps, installMode: 'unknown' }),
  );
  assert.ok(!UPDATE_NOW.test(html), 'one-click needs a positively identified source checkout');
});
