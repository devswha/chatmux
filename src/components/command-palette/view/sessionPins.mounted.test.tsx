import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import i18next from 'i18next';
import type { ReactElement } from 'react';
import { I18nextProvider } from 'react-i18next';
import TestRenderer, { act } from 'react-test-renderer';

import { PaletteOpsProvider, usePaletteOpsRegister } from '../../../contexts/PaletteOpsContext';

import CommandPaletteButton from './CommandPaletteButton';
import SessionPinButton from './SessionPinButton';

async function translated(element: ReactElement) {
  const i18n = i18next.createInstance();
  const common = JSON.parse(readFileSync(new URL('../../../i18n/locales/en/common.json', import.meta.url), 'utf8'));
  await i18n.init({ lng: 'en', fallbackLng: false, resources: { en: { common } }, interpolation: { escapeValue: false } });
  return <I18nextProvider i18n={i18n}>{element}</I18nextProvider>;
}

test('palette launcher uses the registered open callback without keyboard synthesis', async (t) => {
  let opened = 0;
  const order: string[] = [];
  function Register() {
    usePaletteOpsRegister({ openCommandPalette: () => { opened++; order.push('open'); } });
    return <CommandPaletteButton />;
  }
  let renderer!: TestRenderer.ReactTestRenderer;
  const element = await translated(<PaletteOpsProvider><Register /></PaletteOpsProvider>);
  act(() => { renderer = TestRenderer.create(element); });
  t.after(() => act(() => renderer.unmount()));
  act(() => renderer.root.findByType('button').props.onClick({ currentTarget: { focus: () => order.push('focus') } }));
  assert.equal(opened, 1);
  assert.deepEqual(order, ['focus', 'open'], 'the dialog can restore focus to the touch launcher');
});

test('Pin and Unpin are native touch-sized buttons; keyboard events cannot activate the selected navigation row', async (t) => {
  let toggles = 0;
  let renderer!: TestRenderer.ReactTestRenderer;
  const element = await translated(<SessionPinButton pinned={false} name="Session" onToggle={() => { toggles++; }} />);
  act(() => { renderer = TestRenderer.create(element); });
  t.after(() => act(() => renderer.unmount()));
  const button = () => renderer.root.findByType('button');
  assert.equal(button().props['aria-label'], 'Pin Session');
  assert.equal(button().props['aria-pressed'], false);
  assert.equal(button().props.type, 'button');
  assert.match(button().props.className, /h-11 w-11/);
  let stopped = 0;
  for (const key of ['Enter', ' ']) button().props.onKeyDown({ key, stopPropagation: () => stopped++ });
  assert.equal(stopped, 2);
  assert.equal(toggles, 0);
  act(() => button().props.onClick());
  assert.equal(toggles, 1);
  const pinned = await translated(<SessionPinButton pinned name="Session" onToggle={() => { toggles++; }} />);
  act(() => renderer.update(pinned));
  assert.equal(button().props['aria-label'], 'Unpin Session');
  assert.equal(button().props['aria-pressed'], true);
  const disabled = await translated(<SessionPinButton pinned={false} name="Session" disabledReason="Unavailable" onToggle={() => { toggles++; }} />);
  act(() => renderer.update(disabled));
  assert.equal(button().props.disabled, true);
  act(() => button().props.onClick());
  assert.equal(toggles, 1);
});
