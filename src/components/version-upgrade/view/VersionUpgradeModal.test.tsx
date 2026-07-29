import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { compareSemVer, type UpdateJob } from '../../../hooks/useVersionCheck';

import { authoritativeUpdateWait, hasServerRebooted, hasVerifiedServerUpdate, hasVerifiedSourceUpdate, reduceUpdatePhase, sourceAuthorityFromStatus, sourceWaitInitialBootId, VersionUpgradeModal } from './VersionUpgradeModal';

const baseProps = {
  isOpen: true,
  onClose: () => {},
  currentVersion: '1.0.0',
  runningVersion: '1.0.0',
  latestVersion: '1.1.0',
  installMode: 'release' as const,
  clientRefreshAvailable: false,
  serverUpdateAvailable: true,
  canUpdate: true,
  bootId: 'boot-a',
  activeJob: null,
  sourceUpdateInFlight: false,
  sourceUpdate: null,
};

const succeededJob: UpdateJob = { id: 'abcdefghijklmnopqrstuv', phase: 'succeeded', targetVersion: '1.1.0' };

test('hasServerRebooted: only a present, different bootId counts', () => {
  assert.equal(hasServerRebooted('boot-a', { bootId: 'boot-b' }), true);
  assert.equal(hasServerRebooted('boot-a', { bootId: 'boot-a' }), false);
  assert.equal(hasServerRebooted('boot-a', {}), false);
  assert.equal(hasServerRebooted(null, { bootId: 'boot-b' }), false);
});

test('verified release update requires succeeded job, changed bootId, and exact target version', () => {
  assert.equal(hasVerifiedServerUpdate('boot-a', succeededJob, { bootId: 'boot-b', version: '1.1.0' }), true);
  assert.equal(hasVerifiedServerUpdate('boot-a', succeededJob, { bootId: 'boot-a', version: '1.1.0' }), false);
  assert.equal(hasVerifiedServerUpdate('boot-a', succeededJob, { bootId: 'boot-b', version: '1.1.1' }), false);
  assert.equal(hasVerifiedServerUpdate('boot-a', { ...succeededJob, phase: 'failed' }, { bootId: 'boot-b', version: '1.1.0' }), false);
  assert.equal(hasVerifiedServerUpdate('boot-a', succeededJob, null), false);
});

test('source completion retries until health proves a changed, nonempty bootId', () => {
  assert.equal(hasVerifiedSourceUpdate('boot-a', { bootId: 'boot-a' }), false);
  assert.equal(hasVerifiedSourceUpdate('boot-a', { bootId: '' }), false);
  assert.equal(hasVerifiedSourceUpdate('boot-a', { bootId: 'boot-b' }), true);
});
test('authoritative active release job overrides stale source activity while source keeps its correlation', () => {
  const source = { operationId: 'source-op', initialBootId: 'boot-source' };
  assert.deepEqual(authoritativeUpdateWait(succeededJob, source), { mode: 'release', jobId: succeededJob.id });
  assert.deepEqual(authoritativeUpdateWait(null, source), { mode: 'source', ...source });
  assert.equal(authoritativeUpdateWait(null, null), null);
});
test('source polling consumes the canonical nested status contract', () => {
  const status = {
    mode: 'source' as const,
    source: { available: true, inFlight: true, operationId: 'source-op', initialBootId: 'boot-source' },
  };
  assert.equal(sourceAuthorityFromStatus(true, status, 'source-op', 'boot-source'), 'active');
  assert.equal(sourceAuthorityFromStatus(true, status, 'other-op', 'boot-source'), 'inactive');
  assert.equal(sourceAuthorityFromStatus(true, { ...status, source: { ...status.source, inFlight: false } }, 'source-op', 'boot-source'), 'inactive');
  assert.equal(sourceAuthorityFromStatus(false, null, 'source-op', 'boot-source'), 'transient');
  assert.equal(sourceAuthorityFromStatus(true, { mode: 'source' }, 'source-op', 'boot-source'), 'inactive');
});
test('update wait reducer resolves every authoritative release terminal outcome and keeps restart transients retryable', () => {
  const waiting = { kind: 'waiting' as const, mode: 'release' as const, initialBootId: 'boot-a', jobId: 'job-a' };
  for (const kind of ['failed', 'failed_rolled_back', 'failed_rollback', 'manual_required'] as const) {
    assert.deepEqual(reduceUpdatePhase(waiting, { type: 'release_terminal', phase: kind }), { kind });
  }
  assert.deepEqual(reduceUpdatePhase(waiting, { type: 'release_success' }), { kind: 'success' });
  assert.deepEqual(
    reduceUpdatePhase(waiting, { type: 'release_missing', message: 'versionUpdate.errors.start' }),
    { kind: 'failed', message: 'versionUpdate.errors.start' },
  );
  assert.deepEqual(
    reduceUpdatePhase(waiting, { type: 'source_poll', healthSucceeded: false, bootUnchanged: false, authority: 'transient' }),
    waiting,
  );
});
test('capability loss makes an authoritative wait escapable', () => {
  const waiting = { kind: 'waiting' as const, mode: 'release' as const, initialBootId: 'boot-a', jobId: 'job-a' };
  assert.deepEqual(
    reduceUpdatePhase(waiting, { type: 'authority_lost', message: 'versionUpdate.errors.generic' }),
    { kind: 'failed', message: 'versionUpdate.errors.generic' },
  );
  assert.deepEqual(
    reduceUpdatePhase({ kind: 'idle' }, { type: 'authority_lost', message: 'versionUpdate.errors.generic' }),
    { kind: 'idle' },
  );
});

test('retry remains available after a release operation expires and the modal is reopened', () => {
  const failed = reduceUpdatePhase(
    { kind: 'waiting', mode: 'release', initialBootId: 'boot-a', jobId: 'expired-job' },
    { type: 'release_missing', message: 'versionUpdate.errors.start' },
  );
  assert.deepEqual(reduceUpdatePhase(failed, { type: 'retry' }), { kind: 'confirm' });
});

test('source authority waits for changed-boot success before status and rejects inactive or mismatched authority', () => {
  const waiting = { kind: 'waiting' as const, mode: 'source' as const, operationId: 'source-a', initialBootId: 'boot-a' };
  assert.deepEqual(
    reduceUpdatePhase(waiting, { type: 'source_poll', healthSucceeded: true, bootUnchanged: false, authority: 'inactive' }),
    { kind: 'success' },
  );
  assert.deepEqual(
    reduceUpdatePhase(waiting, { type: 'source_poll', healthSucceeded: false, bootUnchanged: true, authority: 'active' }),
    waiting,
  );
  assert.deepEqual(
    reduceUpdatePhase(waiting, { type: 'source_poll', healthSucceeded: false, bootUnchanged: false, authority: 'transient' }),
    waiting,
  );
  assert.deepEqual(
    reduceUpdatePhase(waiting, { type: 'source_poll', healthSucceeded: false, bootUnchanged: true, authority: 'inactive' }),
    { kind: 'failed' },
  );
});

test('a just-started source operation gets one authority propagation poll, then fails inactive authority', () => {
  const started = {
    kind: 'waiting' as const,
    mode: 'source' as const,
    operationId: 'source-a',
    initialBootId: 'boot-a',
    localSourceAuthorityPending: true,
  };
  const propagated = reduceUpdatePhase(started, { type: 'source_poll', healthSucceeded: false, bootUnchanged: true, authority: 'inactive' });
  assert.deepEqual(propagated, { ...started, localSourceAuthorityPending: false });
  assert.deepEqual(
    reduceUpdatePhase(propagated, { type: 'source_poll', healthSucceeded: false, bootUnchanged: true, authority: 'inactive' }),
    { kind: 'failed' },
  );
});

test('source waits reject a mismatched stored baseline and keep sequential operation IDs separate', () => {
  assert.equal(sourceWaitInitialBootId('stale-boot', 'boot-a'), 'boot-a');
  assert.equal(sourceWaitInitialBootId('boot-a', 'boot-a'), 'boot-a');

  const first = { kind: 'waiting' as const, mode: 'source' as const, operationId: 'source-a', initialBootId: 'boot-a' };
  const second = reduceUpdatePhase(first, {
    type: 'set',
    phase: { kind: 'waiting', mode: 'source', operationId: 'source-b', initialBootId: 'boot-b' },
  });
  assert.deepEqual(second, { kind: 'waiting', mode: 'source', operationId: 'source-b', initialBootId: 'boot-b' });
});

test('strict SemVer rejects malformed and prerelease versions', () => {
  assert.equal(compareSemVer('1.0.1', '1.0.0'), 1);
  assert.equal(compareSemVer('1.0.0-beta', '1.0.0'), null);
  assert.equal(compareSemVer('v1.0.0', '1.0.0'), null);
  assert.equal(compareSemVer('1.0', '1.0.0'), null);
  assert.equal(compareSemVer('01.0.0', '1.0.0'), null);
  assert.equal(compareSemVer('999999999999999999999999999999.0.0', '2.0.0'), 1);
  assert.equal(compareSemVer('1.999999999999999999999999999999.0', '1.2.0'), 1);
  assert.equal(compareSemVer('1.0.000000000000000000000000000001', '1.0.1'), null);
});

test('release update copy and action are localized and capability-gated', () => {
  const html = renderToStaticMarkup(createElement(VersionUpgradeModal, baseProps));
  assert.ok(html.includes('versionUpdate.serverUpdate.releaseAvailable'));
  assert.ok(html.includes('versionUpdate.buttons.updateNow'));
  assert.ok(html.includes('versionUpdate.manual.release'));
  assert.ok(html.includes('versionUpdate.ariaLabels.closeButton'));
});

test('source mode exposes the owner-only one-click update and does not present a release target', () => {
  const html = renderToStaticMarkup(createElement(VersionUpgradeModal, { ...baseProps, installMode: 'source', latestVersion: null }));
  assert.ok(html.includes('git pull --ff-only'));
  assert.ok(html.includes('versionUpdate.manual.copyCommand'));
  assert.ok(html.includes('versionUpdate.serverUpdate.sourceAvailable'));
  assert.ok(html.includes('versionUpdate.buttons.updateNow'));
  assert.ok(!html.includes('releaseAvailable'));
});

test('non-owners never receive an update action, including during source updates', () => {
  const html = renderToStaticMarkup(createElement(VersionUpgradeModal, { ...baseProps, installMode: 'source', canUpdate: false }));
  assert.ok(!html.includes('versionUpdate.buttons.updateNow'));
});
test('unknown update status exposes no mutation action', () => {
  const html = renderToStaticMarkup(createElement(VersionUpgradeModal, {
    ...baseProps,
    installMode: 'unknown',
    latestVersion: null,
    serverUpdateAvailable: false,
  }));
  assert.ok(!html.includes('versionUpdate.buttons.updateNow'));
  assert.ok(html.includes('versionUpdate.manual.unknown'));
  assert.ok(!html.includes('git pull --ff-only'));
});

test('terminal release rollback states are not verified for reload', () => {
  assert.equal(hasVerifiedServerUpdate('boot-a', { ...succeededJob, phase: 'failed_rolled_back' }, { bootId: 'boot-b', version: '1.1.0' }), false);
  assert.equal(hasVerifiedServerUpdate('boot-a', { ...succeededJob, phase: 'manual_required' }, { bootId: 'boot-b', version: '1.1.0' }), false);
});

test('a stale client exposes only the standalone localized screen refresh', () => {
  const html = renderToStaticMarkup(createElement(VersionUpgradeModal, {
    ...baseProps,
    clientRefreshAvailable: true,
    serverUpdateAvailable: false,
  }));
  assert.ok(html.includes('versionUpdate.clientRefresh.message'));
  assert.ok(html.includes('versionUpdate.clientRefresh.action'));
  assert.ok(!html.includes('versionUpdate.buttons.updateNow'));
});

test('all update locales interpolate an explicit source or release target version', () => {
  for (const locale of ['de', 'en', 'fr', 'it', 'ja', 'ko', 'ru', 'tr', 'zh-CN', 'zh-TW']) {
    const messages = JSON.parse(
      readFileSync(new URL(`../../../i18n/locales/${locale}/common.json`, import.meta.url), 'utf8'),
    ) as { versionUpdate: { serverUpdate: { sourceAvailable: string; releaseAvailable: string } } };
    assert.match(messages.versionUpdate.serverUpdate.sourceAvailable, /main/i);
    assert.ok(!messages.versionUpdate.serverUpdate.sourceAvailable.includes('{{latestVersion}}'));
    assert.ok(messages.versionUpdate.serverUpdate.sourceAvailable.includes('{{version}}'));
    assert.ok(!messages.versionUpdate.serverUpdate.releaseAvailable.includes('{{latestVersion}}'));
    assert.ok(messages.versionUpdate.serverUpdate.releaseAvailable.includes('{{version}}'));
  }

  const modal = readFileSync(new URL('./VersionUpgradeModal.tsx', import.meta.url), 'utf8');
  assert.match(modal, /sourceAvailable', \{ version: latestVersion \?\? 'main' \}/);
});
