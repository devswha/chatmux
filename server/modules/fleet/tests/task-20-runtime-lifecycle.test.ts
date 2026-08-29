import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { fleetRuntimeEnabled, stopFleetRuntimeServices } from '@/modules/fleet/runtime-lifecycle.js';

test('Given a legacy or fresh environment, when runtime policy resolves, then fleet shares the default server lifecycle', () => {
  // Given / When / Then
  assert.equal(fleetRuntimeEnabled(undefined), true);
  assert.equal(fleetRuntimeEnabled('1'), true);
  assert.equal(fleetRuntimeEnabled('0'), false);
});

test('Given the bundled user service, when systemd stops it, then SIGTERM reaches the ordered runtime drain', async () => {
  // Given / When
  const unit = await readFile('packaging/systemd/chatmux.service', 'utf8');

  // Then
  assert.match(unit, /^KillSignal=SIGTERM$/mu);
  assert.match(unit, /^TimeoutStopSec=30$/mu);
  assert.equal((unit.match(/^ExecStart=/gmu) ?? []).length, 1);
});

test('Given active fleet services, when shutdown starts, then the hub drains before the peer endpoint', async () => {
  // Given
  const calls: string[] = [];

  // When
  await stopFleetRuntimeServices({
    hub: { stop: async () => { calls.push('hub'); } },
    peer: { stop: async () => { calls.push('peer'); } },
  });

  // Then
  assert.deepEqual(calls, ['hub', 'peer']);
});
