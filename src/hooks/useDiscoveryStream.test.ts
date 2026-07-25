import assert from 'node:assert/strict';
import test from 'node:test';

import { discoveryDeltaResyncReason } from './useDiscoveryStream';

test('requests a gap resync when a discovery delta is lost', () => {
  const state = { epoch: 'epoch-1', revision: 4 };
  const lostDeltaFollowup = {
    kind: 'discovery.delta',
    epoch: 'epoch-1',
    prevRevision: 5,
    revision: 6,
    changes: [],
  };

  assert.equal(discoveryDeltaResyncReason(lostDeltaFollowup, state), 'gap');
});

test('requests an epoch resync instead of applying a foreign delta', () => {
  assert.equal(discoveryDeltaResyncReason({
    kind: 'discovery.delta',
    epoch: 'epoch-2',
    prevRevision: 4,
    changes: [],
  }, { epoch: 'epoch-1', revision: 4 }), 'epoch_mismatch');
});
