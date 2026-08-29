import assert from 'node:assert/strict';
import test from 'node:test';

import { FleetPairingFailureLimiter } from '@/modules/fleet/services/fleet-pairing-limiter.service.js';
const NOW = 1_800_000_000_000;

test('blocks the sixth pairing failure for one minute without penalizing another client', () => {
  // Given: five failures from one client.
  let nowMs = NOW;
  const limiter = new FleetPairingFailureLimiter({ now: () => nowMs });
  for (let attempt = 0; attempt < 5; attempt += 1) limiter.recordFailure('client-a');
  // When: admission is checked for two clients.
  const blocked = limiter.admit('client-a');
  const independent = limiter.admit('client-b');
  // Then: only the failing client is blocked until expiry.
  assert.deepEqual(blocked, { allowed: false, retryAfterSeconds: 60 });
  assert.deepEqual(independent, { allowed: true });
  nowMs += 60_000;
  assert.deepEqual(limiter.admit('client-a'), { allowed: true });
});

test('successful pairing clears prior failures', () => {
  // Given: four prior failures.
  const limiter = new FleetPairingFailureLimiter({ now: () => NOW });
  for (let attempt = 0; attempt < 4; attempt += 1) limiter.recordFailure('client');
  // When: success clears the limiter.
  limiter.clear('client');
  // Then: a fresh five-attempt budget is available.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.deepEqual(limiter.admit('client'), { allowed: true });
    limiter.recordFailure('client');
  }
  assert.equal(limiter.admit('client').allowed, false);
});
