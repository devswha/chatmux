import assert from 'node:assert/strict';
import test from 'node:test';

import {
  discoveryAuthorityDisposition,
  discoveryDeltaResyncReason,
  discoveryFrameAuthorityDisposition,
  discoveryHeartbeatDisposition,
  DISCOVERY_TRANSPORT_LANES,
} from './useDiscoveryStream';

test('shared transport subscriptions cover both discovery lanes', () => {
  assert.deepEqual(DISCOVERY_TRANSPORT_LANES, ['external', 'live']);
});
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

test('heartbeat keeps only prior authority and cannot recover discovery authority', () => {
  const heartbeat = {
    kind: 'discovery.heartbeat' as const,
    epoch: 'epoch-1',
    revision: 4,
  };
  const state = { epoch: 'epoch-1', revision: 4 };

  assert.equal(discoveryHeartbeatDisposition(heartbeat, state, true), 'keepalive');
  assert.equal(discoveryHeartbeatDisposition(heartbeat, state, false), 'ignore');
  assert.equal(
    discoveryHeartbeatDisposition({ ...heartbeat, revision: 5 }, state, true),
    'ignore',
  );
});

test('discovery authority requires current healthy evidence independently for each lane', () => {
  const state = { epoch: 'epoch-1', revision: 4 };
  const frame = {
    kind: 'discovery.snapshot',
    epoch: 'epoch-1',
    revision: 4,
    health: {
      external: { ok: true, lastOkRevision: 4 },
      live: { ok: false, lastOkRevision: 4 },
    },
  };

  assert.equal(discoveryFrameAuthorityDisposition(frame, state, 'external', true, true), 'stream');
  assert.equal(discoveryFrameAuthorityDisposition(frame, state, 'live', true, true), 'rest');
  assert.equal(
    discoveryFrameAuthorityDisposition({ ...frame, health: undefined }, state, 'external', true, true),
    'rest',
  );
  assert.equal(
    discoveryFrameAuthorityDisposition(
      { ...frame, health: { external: { ok: true, lastOkRevision: null } } },
      state,
      'external',
      true,
      true,
    ),
    'rest',
  );
  assert.equal(
    discoveryFrameAuthorityDisposition(
      { ...frame, health: { external: { ok: true, lastOkRevision: 5 } } },
      state,
      'external',
      true,
      true,
    ),
    'rest',
  );
});

test('discovery authority clears for stale transport, epoch loss, and resync recovery requires a frame', () => {
  const state = { epoch: 'epoch-1', revision: 4 };
  const frame = {
    kind: 'discovery.delta',
    epoch: 'epoch-1',
    revision: 4,
    health: { live: { ok: true, lastOkRevision: 4 } },
    changes: [],
  };

  assert.equal(discoveryFrameAuthorityDisposition(frame, state, 'live', true, false), 'rest');
  assert.equal(
    discoveryFrameAuthorityDisposition({ ...frame, epoch: 'epoch-2' }, state, 'live', true, true),
    'rest',
  );
  assert.equal(discoveryHeartbeatDisposition(
    { kind: 'discovery.heartbeat', epoch: 'epoch-1', revision: 4 },
    state,
    false,
  ), 'ignore');
  assert.equal(discoveryFrameAuthorityDisposition(frame, state, 'live', true, true), 'stream');
});

test('discovery authority disposition models stream, REST fallback, and absent evidence', () => {
  assert.equal(discoveryAuthorityDisposition(true, true), 'stream');
  assert.equal(discoveryAuthorityDisposition(false, true), 'rest');
  assert.equal(discoveryAuthorityDisposition(false, false), 'none');
});
