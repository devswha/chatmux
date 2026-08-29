import assert from 'node:assert/strict';
import test from 'node:test';

import { isFleetOwner } from './fleetOwner';

test('Given each auth principal, when fleet visibility is resolved, then only owners can see hosts', () => {
  assert.equal(isFleetOwner('none', { username: 'owner' }), true);
  assert.equal(isFleetOwner('password', { username: 'owner' }), true);
  assert.equal(isFleetOwner('tailscale', { username: 'owner', tailscaleRole: 'owner' }), true);
  assert.equal(isFleetOwner('tailscale', { username: 'owner', tailscaleRole: 'local' }), true);
  assert.equal(isFleetOwner('tailscale', { username: 'user', tailscaleRole: 'user' }), false);
  assert.equal(isFleetOwner('tailscale', null), false);
});
