import assert from 'node:assert/strict';
import test from 'node:test';

import { authorizeFleetOwner } from '@/modules/fleet/services/fleet-owner-authorization.service.js';

test('accepts only principals that prove fleet ownership', () => {
  // Given: owner principals from each supported authentication flow.
  const owners = [
    { authMode: 'password' as const, principal: { id: 1 }, remoteAddress: '203.0.113.2' },
    { authMode: 'tailscale' as const, principal: { tailscaleRole: 'owner' }, remoteAddress: '127.0.0.1' },
    { authMode: 'tailscale' as const, principal: { tailscaleRole: 'local' }, remoteAddress: '::1' },
    { authMode: 'none' as const, principal: { id: 1 }, remoteAddress: '::ffff:127.0.0.1' },
  ];
  const denied = [
    { authMode: 'tailscale' as const, principal: { tailscaleRole: 'user' }, remoteAddress: '127.0.0.1' },
    { authMode: 'password' as const, principal: null, remoteAddress: '127.0.0.1' },
    { authMode: 'none' as const, principal: { id: 1 }, remoteAddress: '100.64.0.8' },
  ];

  // When: fleet authorization is evaluated.
  const ownerDecisions = owners.map(authorizeFleetOwner);
  const deniedDecisions = denied.map(authorizeFleetOwner);

  // Then: owners pass and all other callers fail closed.
  assert.deepEqual(ownerDecisions, owners.map(() => ({ authorized: true })));
  assert.deepEqual(deniedDecisions, denied.map(() => ({ authorized: false, reason: 'owner_required' })));
});
