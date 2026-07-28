import assert from 'node:assert/strict';
import test from 'node:test';

import i18next from 'i18next';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';

import type {
  CompletionNotificationDescriptor,
  CompletionNotificationDevice,
  CompletionNotificationStatusItem,
  CompletionNotificationTarget,
} from '../../../../../shared/completion-notifications';
import enSidebar from '../../../../i18n/locales/en/sidebar.json';
import { CompletionNotificationsContext, completionNotificationDescriptorKey } from '../../context/CompletionNotificationsContext';
import type { CompletionNotificationDescriptorStatus, CompletionNotificationReason } from '../../types/types';

import SessionCompletionBell from './SessionCompletionBell';

const descriptor: CompletionNotificationDescriptor = { kind: 'app', provider: 'gjc', sessionId: 'session-1' };
const device: CompletionNotificationDevice = { supported: true, registered: true, setupRequired: false, reason: null };
const target = (watched = false): CompletionNotificationTarget => ({ alias: 'owner-1', kind: 'app', revision: 1, watched });
const item = (watched = false): CompletionNotificationStatusItem => ({
  alias: 'owner-1',
  mappingState: 'one_active',
  reason: 'eligible',
  target: target(watched),
});
const noop = async () => {};
const REPAIRABLE_REASONS = [
  'invalid_subscription',
] as const satisfies readonly CompletionNotificationReason[];
const ENVIRONMENTAL_REASONS = [
  'permission_denied',
  'permission_not_granted',
  'secure_context_required',
  'ios_install_required',
  'unsupported',
] as const satisfies readonly CompletionNotificationReason[];
const NON_REPAIRABLE_REASONS = [
  'settings_changed',
  'target_unavailable',
  'request_failed',
  'refresh_failed',
  'timeout',
] as const satisfies readonly CompletionNotificationReason[];

async function renderBell(overrides: Partial<CompletionNotificationDescriptorStatus> = {}) {
  const eligibleItem = item();
  const status: CompletionNotificationDescriptorStatus = {
    item: eligibleItem,
    target: eligibleItem.mappingState === 'one_active' ? eligibleItem.target : null,
    pending: false,
    error: null,
    globalPaused: false,
    device,
    ...overrides,
  };
  const i18n = i18next.createInstance();
  await i18n.init({ lng: 'en', resources: { en: { sidebar: enSidebar } }, ns: ['sidebar'], defaultNS: 'sidebar' });
  const value = {
    status: null,
    statuses: new Map([[completionNotificationDescriptorKey(descriptor), status]]),
    registerDescriptors: () => () => {},
    setWatch: noop,
    repairDevice: noop,
    refresh: noop,
  };
  return renderToStaticMarkup(createElement(I18nextProvider, { i18n }, createElement(
    CompletionNotificationsContext.Provider,
    { value: value as never },
    createElement(SessionCompletionBell, { descriptor }),
  )));
}

test('SessionCompletionBell renders only for authoritative eligible targets', async () => {
  const ineligibleItem: CompletionNotificationStatusItem = { alias: 'owner-1', mappingState: 'none', reason: 'not_found' };
  const ineligible = await renderBell({ item: ineligibleItem, target: null });
  assert.equal(ineligible, '');
  const eligible = await renderBell();
  assert.match(eligible, new RegExp(enSidebar.completionNotifications.enable));
  assert.match(eligible, /aria-pressed="false"/);
});

test('SessionCompletionBell keeps disabling available while repair is offered separately', async () => {
  const watchedItem = item(true);
  const html = await renderBell({
    item: watchedItem,
    target: watchedItem.target,
    device: { ...device, registered: false, reason: 'endpoint_not_registered' },
  });
  assert.match(html, new RegExp(enSidebar.completionNotifications.repair));
  assert.match(html, new RegExp(enSidebar.completionNotifications.disable));
  assert.equal((html.match(/<button/g) ?? []).length, 2, 'repair is a separate action rather than changing owner intent');
});

test('SessionCompletionBell limits repair to explicit device failures', async () => {
  const watchedItem = item(true);
  const watched = { item: watchedItem, target: watchedItem.target };

  const unknownDevice = await renderBell({ ...watched, device: null });
  assert.equal((unknownDevice.match(/<button/g) ?? []).length, 1, 'an unknown device state is not repairable');

  for (const error of REPAIRABLE_REASONS) {
    const html = await renderBell({ ...watched, error });
    assert.equal((html.match(/<button/g) ?? []).length, 2, `${error} exposes device repair`);
    assert.match(html, new RegExp(`title="${enSidebar.completionNotifications.repair}"`), `${error} uses the imperative repair title`);
    assert.match(html, new RegExp(`aria-label="${enSidebar.completionNotifications.repair}"`), `${error} uses the imperative repair accessible name`);
  }
  for (const error of [...ENVIRONMENTAL_REASONS, ...NON_REPAIRABLE_REASONS]) {
    const html = await renderBell({ ...watched, error });
    assert.equal((html.match(/<button/g) ?? []).length, 1, `${error} does not expose device repair`);
  }
});
test('SessionCompletionBell shows localized environmental guidance without a repair action', async () => {
  for (const [error, message] of [
    ['permission_denied', enSidebar.completionNotifications.denied],
    ['permission_not_granted', enSidebar.completionNotifications.denied],
    ['secure_context_required', enSidebar.completionNotifications.insecure],
    ['ios_install_required', enSidebar.completionNotifications.iosInstall],
    ['unsupported', enSidebar.completionNotifications.unsupported],
  ] as const satisfies readonly (readonly [CompletionNotificationReason, string])[]) {
    const html = await renderBell({ error });
    assert.match(html, new RegExp(message.replace(/[.?]/g, '\\$&')), `${error} explains what prevents notifications`);
    assert.match(html, /class="max-w-48 text-xs text-destructive"/, `${error} guidance is visible`);
    assert.equal((html.match(/<button/g) ?? []).length, 1, `${error} does not offer repair`);
  }
});

test('SessionCompletionBell announces errors without changing pressed owner intent', async () => {
  for (const [error, message] of [
    ['timeout', enSidebar.completionNotifications.timeout],
    ['settings_changed', enSidebar.completionNotifications.conflict],
  ] as const satisfies readonly (readonly [CompletionNotificationReason, string])[]) {
    const watchedItem = item(true);
    const html = await renderBell({ error, item: watchedItem, target: watchedItem.target });
    assert.match(html, new RegExp(message.replace(/[.?]/g, '\\$&')));
    assert.match(html, /role="status" aria-live="polite"/);
    assert.match(html, /aria-pressed="true"/);
  }
});

test('SessionCompletionBell composes paused status with concurrent error and pending state', async () => {
  const watchedItem = item(true);
  const pausedWithError = await renderBell({
    item: watchedItem,
    target: watchedItem.target,
    globalPaused: true,
    error: 'settings_changed',
  });
  assert.match(pausedWithError, new RegExp(enSidebar.completionNotifications.paused));
  assert.match(pausedWithError, new RegExp(enSidebar.completionNotifications.conflict.replace(/[.?]/g, '\\$&')));
  assert.match(pausedWithError, /aria-pressed="true"/);

  const pausedWhilePending = await renderBell({ globalPaused: true, pending: true });
  assert.match(pausedWhilePending, new RegExp(enSidebar.completionNotifications.pending));
  assert.match(pausedWhilePending, new RegExp(enSidebar.completionNotifications.paused));
  assert.match(pausedWhilePending, /disabled=""/);
});
test('SessionCompletionBell disables pending spinner motion when reduced motion is requested', async () => {
  const html = await renderBell({ pending: true });
  assert.match(html, /animate-spin motion-reduce:animate-none/);
});

test('SessionCompletionBell retains keyboard semantics and 44px touch targets', async () => {
  const watchedItem = item(true);
  const html = await renderBell({
    item: watchedItem,
    target: watchedItem.target,
    device: { ...device, registered: false, reason: 'endpoint_not_registered' },
  });
  assert.match(html, /type="button"/);
  assert.match(html, /focus-visible:ring-2/);
  assert.equal((html.match(/h-11 w-11/g) ?? []).length, 2, 'both keyboard buttons meet the 44px mobile target');
});
