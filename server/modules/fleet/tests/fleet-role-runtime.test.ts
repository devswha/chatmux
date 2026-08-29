import assert from 'node:assert/strict';
import test from 'node:test';

import { HubPeerConnectionRegistry } from '@/modules/fleet/hub/connection/registry.js';

const PEER_ID = '00000000-0000-4000-8000-000000000001';

test('Given corrupt dual-role persistence, when hub reconciliation starts, then it fails before dialing', () => {
  // Given
  let dialCalls = 0;
  const subject = new HubPeerConnectionRegistry({
    assertRoleIntegrity: () => { const error = new Error('revoke the inbound hub grant or remove all outbound peers'); error.name = 'FleetRoleConflictDataError'; throw error; },
    peers: { list: () => [{ peerId: PEER_ID, url: 'wss://peer.example/fleet-ws', transportMode: 'direct-wss', pinnedPublicKey: 'key', enrollmentState: 'enrolled' }] },
    local: { signer: { installationId: '10000000-0000-4000-8000-000000000001', sign: async () => new Uint8Array(64) }, processEpoch: 'hub', capabilities: ['catalog.read'] },
    scheduler: { nowMs: 1, schedule: () => ({ cancel: () => undefined }) },
    random: () => 0.5,
    dial: () => { dialCalls += 1; throw new TypeError('dial must not run'); },
    recordNegotiation: () => undefined,
    onFrame: () => undefined,
  });

  // When / Then
  assert.throws(() => subject.start(), { name: 'FleetRoleConflictDataError' });
  assert.equal(dialCalls, 0);
});
