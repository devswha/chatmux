import assert from 'node:assert/strict';
import test from 'node:test';

import i18next from 'i18next';
import { createElement } from 'react';
import { I18nextProvider } from 'react-i18next';
import TestRenderer, { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import enSettings from '../../../../../i18n/locales/en/settings.json';
import { FleetSettingsRequestError } from '../../../fleet/fleetApi';
import type { FleetSshEnrollmentInput, FleetSshEnrollmentResult } from '../../../fleet/types';

import { FleetEnrollmentForm } from './FleetEnrollmentForm';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

async function mount(onSshEnroll: (input: FleetSshEnrollmentInput) => Promise<FleetSshEnrollmentResult>) {
  const i18n = i18next.createInstance();
  await i18n.init({
    lng: 'en',
    fallbackLng: false,
    resources: { en: { settings: enSettings } },
    ns: ['settings'],
    defaultNS: 'settings',
    interpolation: { escapeValue: false },
  });
  return TestRenderer.create(createElement(
    I18nextProvider,
    { i18n },
    createElement(FleetEnrollmentForm, {
      pending: false,
      onEnroll: async () => undefined,
      onSshEnroll,
    }),
  ));
}

function change(field: ReactTestInstance, value: string): void {
  field.props.onChange({ target: { value } });
}

async function selectSshEasy(renderer: ReactTestRenderer): Promise<void> {
  await act(async () => {
    change(renderer.root.findByType('select'), 'ssh-easy');
  });
}

test('Given manual enrollment, when SSH easy mode is selected, then SSH fields replace the manual fields', async () => {
  const renderer = await mount(async () => ({ peerId: 'peer-a', port: 8022 }));

  await selectSshEasy(renderer);

  assert.equal(renderer.root.findAllByProps({ name: 'sshTarget' }).length, 1);
  assert.equal(renderer.root.findAllByProps({ name: 'password' }).length, 1);
  assert.equal(renderer.root.findAllByProps({ name: 'peerUrl' }).length, 0);
  assert.equal(renderer.root.findAllByProps({ name: 'token' }).length, 0);
  renderer.unmount();
});

test('Given SSH easy mode, when credentials are incomplete or the target is invalid, then submit stays disabled', async () => {
  const renderer = await mount(async () => ({ peerId: 'peer-a', port: 8022 }));
  await selectSshEasy(renderer);
  const submit = () => renderer.root.findByProps({ type: 'submit' });
  const target = renderer.root.findByProps({ name: 'sshTarget' });
  const password = renderer.root.findByProps({ name: 'password' });

  assert.equal(submit().props.disabled, true);
  await act(async () => { change(target, 'missing-user.example.com'); change(password, 'secret'); });
  assert.equal(submit().props.disabled, true);
  await act(async () => { change(target, 'devswha@192.168.1.50:22'); });
  assert.equal(submit().props.disabled, false);
  renderer.unmount();
});

test('Given valid SSH credentials, when submitted, then trimmed transient values reach the SSH handler', async () => {
  let received: FleetSshEnrollmentInput | null = null;
  const renderer = await mount(async (input) => { received = input; return { peerId: 'peer-a', port: 8022 }; });
  await selectSshEasy(renderer);

  await act(async () => {
    change(renderer.root.findByProps({ name: 'sshTarget' }), '  devswha@192.168.1.50  ');
    change(renderer.root.findByProps({ name: 'password' }), 'secret');
    change(renderer.root.findByProps({ name: 'label' }), '  Studio  ');
  });
  await act(async () => {
    renderer.root.findByType('form').props.onSubmit({ preventDefault: () => undefined });
    await tick();
  });

  assert.deepEqual(received, { sshTarget: 'devswha@192.168.1.50', password: 'secret', label: 'Studio' });
  assert.equal(renderer.root.findAllByProps({ role: 'status' }).some((node) => node.children.join('').includes('8022')), true);
  renderer.unmount();
});

test('Given a closed enrollment error, when submission fails, then its localized message is shown', async () => {
  const renderer = await mount(async () => { throw new FleetSettingsRequestError('SSH_AUTH_FAILED', 401); });
  await selectSshEasy(renderer);
  await act(async () => {
    change(renderer.root.findByProps({ name: 'sshTarget' }), 'devswha@192.168.1.50');
    change(renderer.root.findByProps({ name: 'password' }), 'wrong');
  });

  await act(async () => {
    renderer.root.findByType('form').props.onSubmit({ preventDefault: () => undefined });
    await tick();
  });

  assert.equal(renderer.root.findByProps({ role: 'alert' }).children.join(''), enSettings.fleet.sshEasy.errors.SSH_AUTH_FAILED);
  renderer.unmount();
});
