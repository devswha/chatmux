import assert from 'node:assert/strict';
import test from 'node:test';

import { fleetPeerRevocationGateway } from '../peer/revocation-gateway.js';

test('the revocation gateway forwards to the bound peer runtime only while it is bound', () => {
  let calls = 0;
  const handler = () => { calls += 1; };

  assert.equal(fleetPeerRevocationGateway.notifyRevoked(), false, 'no runtime bound yet');
  fleetPeerRevocationGateway.bind(handler);
  assert.equal(fleetPeerRevocationGateway.notifyRevoked(), true);
  assert.equal(calls, 1);

  const other = () => {};
  fleetPeerRevocationGateway.unbind(other);
  assert.equal(fleetPeerRevocationGateway.notifyRevoked(), true, 'unbinding a different handler leaves the bound one');
  fleetPeerRevocationGateway.unbind(handler);
  assert.equal(fleetPeerRevocationGateway.notifyRevoked(), false);
  assert.equal(calls, 2);
});
