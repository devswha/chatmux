import assert from 'node:assert/strict';
import test from 'node:test';

import i18next from 'i18next';
import { createElement } from 'react';
import { I18nextProvider } from 'react-i18next';
import TestRenderer, { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import enSettings from '../../../../../i18n/locales/en/settings.json';
import { fleetApi, FleetSettingsRequestError } from '../../../fleet/fleetApi';
import type { FleetSettingsPayload, FleetSshEnrollmentInput, FleetSshEnrollmentResult } from '../../../fleet/types';
import { useFleetSettings } from '../../../fleet/useFleetSettings';

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
  assert.equal(renderer.root.findByProps({ name: 'installCli' }).props.checked, false, 'remote installation requires explicit opt-in');
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

  assert.deepEqual(received, { sshTarget: 'devswha@192.168.1.50', password: 'secret', label: 'Studio', installCli: false });
  assert.equal(renderer.root.findByProps({ name: 'password' }).props.value, '', 'the credential is cleared after submission');
  assert.equal(renderer.root.findAllByType('p').some((node) => node.children.join('') === enSettings.fleet.sshEasy.keyDisclosure), true, 'the key-install disclosure is rendered');
  assert.equal(renderer.root.findAllByProps({ role: 'status' }).some((node) => node.children.join('').includes('8022')), true);
  renderer.unmount();
});

test('Given the settings hook SSH handler, when enrollment succeeds, then parent settings are refreshed', async () => {
  const originalSettings = fleetApi.settings; const originalSshEnroll = fleetApi.sshEnroll;
  const payload: FleetSettingsPayload = { local: { installationId: 'local', publicKeyFingerprint: 'sha256:local' }, role: 'standalone', capacity: { totalInstallations: 10, remotePeers: 9 }, peers: [] };
  let settingsCalls = 0; let hook: ReturnType<typeof useFleetSettings> | undefined;
  Object.defineProperty(fleetApi, 'settings', { configurable: true, value: async () => { settingsCalls += 1; return payload; } });
  Object.defineProperty(fleetApi, 'sshEnroll', { configurable: true, value: async () => ({ peerId: 'peer-a', port: 8022 }) });
  function Harness() { hook = useFleetSettings(); return createElement('div'); }
  let renderer: ReactTestRenderer | undefined;
  try {
    await act(async () => { renderer = TestRenderer.create(createElement(Harness)); await tick(); });
    assert.ok(hook);
    await act(async () => { await hook?.sshEnroll({ sshTarget: 'alice@example.test', password: 'secret' }); });
    assert.equal(settingsCalls, 2);
  } finally {
    renderer?.unmount();
    Object.defineProperty(fleetApi, 'settings', { configurable: true, value: originalSettings });
    Object.defineProperty(fleetApi, 'sshEnroll', { configurable: true, value: originalSshEnroll });
  }
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

async function submitSsh(renderer: ReactTestRenderer): Promise<void> {
  await act(async () => {
    change(renderer.root.findByProps({ name: 'sshTarget' }), 'devswha@100.64.0.5');
    change(renderer.root.findByProps({ name: 'password' }), 'secret');
  });
  await act(async () => {
    renderer.root.findByType('form').props.onSubmit({ preventDefault: () => undefined });
    await tick();
  });
}

test('Given the install toggle is cleared, when submitted, then installCli false reaches the SSH handler', async () => {
  let received: FleetSshEnrollmentInput | null = null;
  const renderer = await mount(async (input) => { received = input; return { peerId: 'peer-a', port: 8022 }; });
  await selectSshEasy(renderer);
  await act(async () => { renderer.root.findByProps({ name: 'installCli' }).props.onChange({ target: { checked: false } }); });
  await submitSsh(renderer);
  assert.deepEqual(received, { sshTarget: 'devswha@100.64.0.5', password: 'secret', installCli: false });
  renderer.unmount();
});

test('bootstrap is explicitly selected and the password field clears while the request is pending', async () => {
  let finish!: (value: FleetSshEnrollmentResult) => void;
  let received: FleetSshEnrollmentInput | undefined;
  const renderer = await mount((input) => { received = input; return new Promise((resolve) => { finish = resolve; }); });
  await selectSshEasy(renderer);
  await act(async () => { renderer.root.findByProps({ name: 'installCli' }).props.onChange({ target: { checked: true } }); });
  await submitSsh(renderer);
  assert.equal(received?.installCli, true);
  assert.equal(received?.password, 'secret');
  assert.equal(renderer.root.findByProps({ name: 'password' }).props.value, '');
  assert.equal(renderer.root.findByProps({ type: 'submit' }).props.disabled, true);
  await act(async () => { finish({ peerId: 'peer-a', port: 8022 }); await tick(); });
  renderer.unmount();
});

test('a network failure displays a generic error and requires fresh credentials without an unhandled rejection', async () => {
  const renderer = await mount(async () => { throw new TypeError('private network diagnostic'); });
  await selectSshEasy(renderer);
  await submitSsh(renderer);
  assert.equal(renderer.root.findByProps({ role: 'alert' }).children.join(''), enSettings.fleet.sshEasy.errors.ENROLL_FAILED);
  assert.equal(renderer.root.findByProps({ type: 'submit' }).props.disabled, true);
  assert.equal(renderer.root.findAllByType('code').length, 0);
  renderer.unmount();
});

test('Given an unsupported remote platform, when enrollment fails, then the platform is named; a missing CLI shows the manual install command', async () => {
  const unsupported = await mount(async () => { throw new FleetSettingsRequestError('REMOTE_PLATFORM_UNSUPPORTED', 409, { os: 'Darwin', arch: 'arm64' }); });
  await selectSshEasy(unsupported);
  await submitSsh(unsupported);
  assert.equal(unsupported.root.findByProps({ role: 'alert' }).children.join(''), 'Automatic installation requires Linux x86_64. This PC reports Darwin arm64.');
  assert.equal(unsupported.root.findAllByType('code').length, 0, 'an install command is useless on an unsupported platform');
  unsupported.unmount();

  const missing = await mount(async () => { throw new FleetSettingsRequestError('REMOTE_CLI_MISSING', 409); });
  await selectSshEasy(missing);
  await submitSsh(missing);
  assert.equal(missing.root.findByProps({ role: 'alert' }).children.join(''), enSettings.fleet.sshEasy.errors.REMOTE_CLI_MISSING);
  assert.match(missing.root.findByType('code').children.join(''), /^curl -fsSL https:\/\/github\.com\/devswha\/chatmux\/releases\/latest\/download\/install\.sh \| bash -s -- --port 3001$/);
  missing.unmount();
});

test('Given tailnet candidates, when a PC is picked, then the SSH target and label are pre-filled and unsupported PCs are flagged', async () => {
  const original = fleetApi.sshCandidates;
  Object.defineProperty(fleetApi, 'sshCandidates', { configurable: true, value: async () => ({
    available: true,
    defaultUser: 'devswha',
    candidates: [
      { hostName: 'lab-box', address: '100.64.0.9', os: 'linux', online: true, supported: true },
      { hostName: 'macbookpro', address: '100.64.0.5', os: 'macOS', online: true, supported: false },
    ],
  }) });
  try {
    const renderer = await mount(async () => ({ peerId: 'peer-a', port: 8022 }));
    await selectSshEasy(renderer);
    await act(async () => { await tick(); });
    const picker = renderer.root.findByProps({ name: 'sshCandidate' });
    assert.equal(picker.findAllByType('option').length, 3);
    await act(async () => { change(picker, '100.64.0.9'); });
    assert.equal(renderer.root.findByProps({ name: 'sshTarget' }).props.value, 'devswha@100.64.0.9');
    assert.equal(renderer.root.findByProps({ name: 'label' }).props.value, 'lab-box');
    await act(async () => { change(renderer.root.findByProps({ name: 'sshCandidate' }), '100.64.0.5'); });
    assert.equal(renderer.root.findByProps({ name: 'sshTarget' }).props.value, 'devswha@100.64.0.5');
    assert.equal(renderer.root.findByProps({ name: 'label' }).props.value, 'lab-box', 'a label typed or filled earlier is kept');
    assert.ok(renderer.root.findAllByType('span').some((node) => node.children.join('') === 'This PC reports macOS. Automatic installation requires Linux x86_64.'));
    renderer.unmount();
  } finally {
    Object.defineProperty(fleetApi, 'sshCandidates', { configurable: true, value: original });
  }
});
