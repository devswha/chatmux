import assert from 'node:assert/strict';
import test from 'node:test';

import {
  deriveUpgradeStatus,
  ubuntuVersionAtLeast,
} from './os-preflight-status.mjs';

const healthyGates = {
  freeBytes: 100 * 1024 * 1024 * 1024,
  packageHolds: 0,
  dpkgAuditEntries: 0,
  failedSystemUnits: 0,
  rebootRequired: false,
  nonInteractiveSudo: false,
};

test('ubuntuVersionAtLeast compares dotted release versions numerically', () => {
  assert.equal(ubuntuVersionAtLeast('24.04', '24.04'), true);
  assert.equal(ubuntuVersionAtLeast('24.10', '24.04'), true);
  assert.equal(ubuntuVersionAtLeast('22.04', '24.04'), false);
});

test('an already upgraded healthy host is complete and not sudo-blocked', () => {
  assert.deepEqual(deriveUpgradeStatus({
    currentVersion: '24.04',
    targetAvailable: false,
    gates: healthyGates,
  }), {
    desiredVersion: '24.04',
    reachedTarget: true,
    readyForAuthorizedUpgrade: false,
    upgradeComplete: true,
    blocked: false,
    blocker: null,
  });
});

test('a pre-upgrade host can be ready while interactive sudo remains required', () => {
  const status = deriveUpgradeStatus({
    currentVersion: '22.04',
    targetAvailable: true,
    gates: healthyGates,
  });
  assert.equal(status.readyForAuthorizedUpgrade, true);
  assert.equal(status.upgradeComplete, false);
  assert.equal(status.blocked, true);
});

test('an upgraded host with a pending reboot is not complete', () => {
  const status = deriveUpgradeStatus({
    currentVersion: '24.04',
    targetAvailable: false,
    gates: { ...healthyGates, rebootRequired: true },
  });
  assert.equal(status.reachedTarget, true);
  assert.equal(status.upgradeComplete, false);
  assert.equal(status.blocked, false);
});
