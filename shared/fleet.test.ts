import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FLEET_CAPABILITIES,
  FLEET_ERROR_CODES,
  FLEET_PROTOCOL_VERSION,
  FleetContractError,
  fleetCapabilityLabel,
  fleetErrorStatus,
  fleetReferenceDigest,
  parseFleetEventEnvelope,
  parseFleetRequestEnvelope,
  parseFleetResponseEnvelope,
} from './fleet.js';

const hostA = '018f2d8a-7d5a-4c36-9b49-bd0b54f59b8a';
const hostB = 'a9aab9cc-4e4f-4d17-90fa-0c86999790d1';
const hostTarget = { kind: 'host', hostId: hostA } as const;
const sessionTarget = { kind: 'session', hostId: hostA, localId: 'session-42' } as const;
const projectTarget = { kind: 'project', hostId: hostA, localId: 'project-42' } as const;
const paneTarget = { kind: 'pane', hostId: hostA, localId: 'session-42', lane: 'external', tmux: {
  socketPath: '/tmp/tmux.sock', sessionId: '$1', windowId: '@1', paneId: '%1',
}, process: { pid: 42, startedAtMs: 1 } } as const;

function assertMalformedRequest(operation: string, target: Readonly<Record<string, unknown>>): void {
  assert.throws(
    () => parseFleetRequestEnvelope({
      kind: 'request', protocolVersion: FLEET_PROTOCOL_VERSION, connectionGeneration: 1,
      requestId: 'request-1', operation, target, body: null,
    }),
    (error: unknown) => error instanceof FleetContractError && error.code === 'FLEET_MALFORMED_FRAME',
  );
}

test('Given equal local session IDs on distinct hosts, When keyed, Then their digests remain distinct', async () => {
  const localSession = { kind: 'session', hostId: hostA, localId: 'session-42' } as const;
  const remoteSession = { kind: 'session', hostId: hostB, localId: 'session-42' } as const;

  assert.notEqual(await fleetReferenceDigest(localSession), await fleetReferenceDigest(remoteSession));
});

test('Given valid fleet frames, When parsed, Then their closed envelope contracts round-trip', () => {
  const target = paneTarget;
  const request = parseFleetRequestEnvelope({
    kind: 'request', protocolVersion: FLEET_PROTOCOL_VERSION, connectionGeneration: 1,
    requestId: 'request-1', operation: 'pane.capture', target, body: { lines: 100 },
  });
  const response = parseFleetResponseEnvelope({
    kind: 'response', protocolVersion: FLEET_PROTOCOL_VERSION, connectionGeneration: 1,
    requestId: 'request-1', target, status: 'success', sideEffect: 'none', body: { text: 'ok' },
  });
  const event = parseFleetEventEnvelope({
    kind: 'event', protocolVersion: FLEET_PROTOCOL_VERSION, connectionGeneration: 1,
    eventId: 'event-1', event: 'catalog.snapshot', hostId: hostA, body: { revision: 1 },
  });

  assert.equal(request.target.hostId, hostA);
  assert.equal(response.status, 'success');
  assert.equal(event.event, 'catalog.snapshot');
});

test('Given uppercase or non-v4 host IDs, When parsed, Then each fails as an invalid identifier', () => {
  for (const hostId of ['018F2D8A-7D5A-4C36-9B49-BD0B54F59B8A', '6ba7b810-9dad-11d1-80b4-00c04fd430c8']) {
    assert.throws(
      () => parseFleetRequestEnvelope({
        kind: 'request', protocolVersion: FLEET_PROTOCOL_VERSION, connectionGeneration: 1,
        requestId: 'request-1', operation: 'catalog.snapshot', target: { kind: 'host', hostId }, body: null,
      }),
      (error: unknown) => error instanceof FleetContractError && error.code === 'FLEET_IDENTIFIER_INVALID',
    );
  }
});

test('Given an operation with a mismatched target, When parsed, Then it fails as malformed', () => {
  assertMalformedRequest('session.read', projectTarget);
  assertMalformedRequest('catalog.snapshot', sessionTarget);
  assertMalformedRequest('session.spawn', sessionTarget);
  assertMalformedRequest('pane.capture', sessionTarget);
});

test('Given every operation and its exact target kind, When parsed, Then each correlation is accepted', () => {
  const requests = [
    ['catalog.snapshot', hostTarget],
    ['session.read', sessionTarget], ['session.history', sessionTarget], ['chat.send', sessionTarget], ['chat.abort', sessionTarget], ['prompt.read', sessionTarget], ['prompt.respond', sessionTarget], ['approval.read', sessionTarget], ['approval.respond', sessionTarget],
    ['session.search', projectTarget], ['session.spawn', projectTarget],
    ['pane.capture', paneTarget], ['pane.attach', paneTarget], ['pane.input', paneTarget], ['pane.resize', paneTarget], ['pane.interrupt', paneTarget], ['pane.escape', paneTarget], ['pane.terminate', paneTarget], ['process.terminate', paneTarget], ['session.terminate', paneTarget],
  ] as const;

  for (const [operation, target] of requests) {
    assert.equal(parseFleetRequestEnvelope({
      kind: 'request', protocolVersion: FLEET_PROTOCOL_VERSION, connectionGeneration: 1,
      requestId: `${operation}-1`, operation, target, body: null,
    }).target.kind, target.kind);
  }
});

test('Given malformed fleet inputs, When parsed, Then each fails closed', async () => {
  const target = { kind: 'session', hostId: hostA, localId: 'session-42' } as const;
  assert.throws(() => parseFleetRequestEnvelope({
    kind: 'request', protocolVersion: FLEET_PROTOCOL_VERSION, connectionGeneration: 1,
    requestId: 'request-1', operation: 'session.read', target: { kind: 'session', localId: 'session-42' }, body: null,
  }));
  // RFC revision 3 keeps bodies opaque; enums are validated in descriptors,
  // not in arbitrary operation payloads that happen to reuse a field name.
  const opaque = { capabilities: ['catalog.read', 'catalog.read'] };
  assert.deepEqual(parseFleetEventEnvelope({
    kind: 'event', protocolVersion: FLEET_PROTOCOL_VERSION, connectionGeneration: 1,
    eventId: 'event-1', event: 'catalog.snapshot', hostId: hostA,
    body: opaque,
  }).body, opaque);
  assert.throws(() => parseFleetResponseEnvelope({
    kind: 'response', protocolVersion: FLEET_PROTOCOL_VERSION, connectionGeneration: 1,
    requestId: 'request-1', target, status: 'failure', sideEffect: 'none', error: 'UNKNOWN', body: null,
  }));
  assert.throws(() => parseFleetRequestEnvelope({
    kind: 'request', protocolVersion: FLEET_PROTOCOL_VERSION, connectionGeneration: 1,
    requestId: 'x'.repeat(257), operation: 'session.read', target, body: null,
  }));
  const digest = await fleetReferenceDigest(target);
  assert.notEqual(digest, await fleetReferenceDigest({ ...target, localId: 'session-43' }));
});

test('Given fleet capability and error unions, When consumed, Then every variant has an exhaustive mapping', () => {
  for (const capability of FLEET_CAPABILITIES) assert.notEqual(fleetCapabilityLabel(capability), '');
  for (const code of FLEET_ERROR_CODES) assert.ok(fleetErrorStatus(code) >= 400);
});
