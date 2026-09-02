import assert from 'node:assert/strict';
import test from 'node:test';

import type { FleetRequestEnvelope } from '../../../../shared/fleet.js';
import { createPeerOperationDispatcher } from '../peer/operation-dispatcher.js';

const HOST = '123e4567-e89b-42d3-a456-426614174000';

function request(operation: FleetRequestEnvelope['operation'], requestId: string): FleetRequestEnvelope {
  return {
    kind: 'request', protocolVersion: 'fleet/1', connectionGeneration: 4, requestId, operation,
    target: { kind: 'host', hostId: HOST }, body: null,
  } as FleetRequestEnvelope;
}

test('an unmapped handler exception answers that request and never escapes to the connection', async () => {
  const logged: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
  try {
    const dispatch = createPeerOperationDispatcher(HOST, {
      'chat.send': async () => { throw new Error('database is locked'); },
      'pane.capture': async () => { throw new TypeError('roster row missing'); },
      'catalog.snapshot': async () => ({ ok: true }),
    });
    const mutation = await dispatch(request('chat.send', 'm-1'));
    assert.equal(mutation.status, 'failure');
    if (mutation.status !== 'failure') throw new TypeError('failure expected');
    assert.equal(mutation.error, 'HOST_COMMAND_OUTCOME_UNKNOWN', 'a mutation may have partially run');
    assert.equal(mutation.sideEffect, 'possible');
    assert.equal(mutation.requestId, 'm-1');

    const read = await dispatch(request('pane.capture', 'r-1'));
    assert.equal(read.status, 'failure');
    if (read.status !== 'failure') throw new TypeError('failure expected');
    assert.equal(read.error, 'FLEET_UNKNOWN_ERROR');
    assert.equal(read.sideEffect, 'none');

    const healthy = await dispatch(request('catalog.snapshot', 'ok-1'));
    assert.equal(healthy.status, 'success', 'the connection keeps serving after a failed request');
    assert.equal(logged.length, 2);
    assert.ok(logged.every((line) => /chat\.send m-1|pane\.capture r-1/u.test(line)), 'the log names the request, never the body');
  } finally {
    console.error = originalError;
  }
});
