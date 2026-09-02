import assert from 'node:assert/strict';
import test from 'node:test';

import { parseFleetEventEnvelope, parseFleetRequestEnvelope } from '../../../../shared/fleet.js';

const HOST_ID = '123e4567-e89b-42d3-a456-426614174000';

test('Given the shared fleet request boundary, when generation is stale, then parsing fails before dispatch', () => {
  const request = {
    kind: 'request',
    protocolVersion: 'fleet/1',
    connectionGeneration: 0,
    requestId: 'request-1',
    operation: 'catalog.snapshot',
    target: { kind: 'host', hostId: HOST_ID },
    body: null,
  };

  assert.throws(() => parseFleetRequestEnvelope(request), /positive integer/);
});

test('Given the shared fleet request boundary, when a valid request arrives, then its typed operation is preserved', () => {
  const request = {
    kind: 'request',
    protocolVersion: 'fleet/1',
    connectionGeneration: 1,
    requestId: 'request-1',
    operation: 'catalog.snapshot',
    target: { kind: 'host', hostId: HOST_ID },
    body: null,
  };

  assert.equal(parseFleetRequestEnvelope(request).operation, 'catalog.snapshot');
});

test('Given a chat.delta body carrying a provider-shaped "capabilities" object, when parsed, then it stays opaque JSON', () => {
  const event = {
    kind: 'event',
    protocolVersion: 'fleet/1',
    connectionGeneration: 3,
    eventId: 'event-1',
    event: 'chat.delta',
    hostId: HOST_ID,
    body: { text: 'mcp initialize', capabilities: { tools: { listChanged: true }, prompts: {} } },
  };
  const parsed = parseFleetEventEnvelope(event);
  assert.deepEqual(parsed.body, event.body, 'an MCP initialize result is not the fleet capability enum');
  const nested = { ...event, body: { steps: [{ capabilities: ['not-a-fleet-capability'] }] } };
  assert.deepEqual(parseFleetEventEnvelope(nested).body, nested.body);
});
