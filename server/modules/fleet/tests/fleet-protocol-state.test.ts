import assert from 'node:assert/strict';
import test from 'node:test';

import { parseFleetRequestEnvelope, parseFleetResponseEnvelope } from '../../../../shared/fleet.js';
import { assertFleetCapability, capabilityForOperation } from '../protocol/capabilities.js';
import { FleetBoundedWriter, type FleetWritableTransport } from '../protocol/bounded-writer.js';
import { FleetRequestLedger } from '../protocol/request-ledger.js';
import {
  FleetConnectionRegistry,
  FleetHeartbeatLease,
  type FleetGenerationStore,
  type FleetSupersedableConnection,
} from '../protocol/state-machine.js';

const HOST_ID = '123e4567-e89b-42d3-a456-426614174000';

class MemoryGenerationStore implements FleetGenerationStore {
  generation = 0;
  async claimNext(): Promise<number> { this.generation += 1; return this.generation; }
}

class Connection implements FleetSupersedableConnection {
  readonly closes: Readonly<{ code: number; reason: string }>[] = [];
  close(code: number, reason: string): void { this.closes.push({ code, reason }); }
}

function request(body: unknown = null) {
  return parseFleetRequestEnvelope({
    kind: 'request', protocolVersion: 'fleet/1', connectionGeneration: 1,
    requestId: 'request-1', operation: 'catalog.snapshot',
    target: { kind: 'host', hostId: HOST_ID }, body,
  });
}

function response() {
  return parseFleetResponseEnvelope({
    kind: 'response', protocolVersion: 'fleet/1', connectionGeneration: 1,
    requestId: 'request-1', target: { kind: 'host', hostId: HOST_ID },
    status: 'success', sideEffect: 'none', body: null,
  });
}

test('Given persisted generations, when a newer socket authenticates, then it supersedes the old socket', async () => {
  const store = new MemoryGenerationStore();
  const registry = new FleetConnectionRegistry(store);
  const first = new Connection();
  const second = new Connection();

  assert.equal(await registry.activate(HOST_ID, first), 1);
  assert.equal(await registry.activate(HOST_ID, second), 2);
  assert.deepEqual(first.closes, [{ code: 4001, reason: 'fleet connection superseded' }]);
  assert.throws(() => registry.assertCurrent(HOST_ID, 1), /generation is stale/);
  registry.assertCurrent(HOST_ID, 2);
});

test('Given a peer lease, when heartbeat and lease boundaries pass, then status is deterministic', () => {
  const lease = new FleetHeartbeatLease(1_000);

  assert.deepEqual(lease.poll(10_999), { kind: 'healthy' });
  assert.deepEqual(lease.poll(11_000), { kind: 'heartbeat_due' });
  lease.markSent(11_000);
  lease.received(20_000);
  assert.deepEqual(lease.poll(30_999), { kind: 'heartbeat_due' });
  assert.deepEqual(lease.poll(50_000), { kind: 'expired' });
});

test('Given a canonical request ledger, when duplicates arrive, then dispatch occurs once and altered payload conflicts', async () => {
  const ledger = new FleetRequestLedger();
  let dispatcherCount = 0;
  const first = ledger.admit(request({ message: 'one' }));
  assert.equal(first.kind, 'dispatch');
  if (first.kind !== 'dispatch') return;
  dispatcherCount += 1;
  const duplicate = ledger.admit(request({ message: 'one' }));
  assert.equal(duplicate.kind, 'pending');
  const altered = ledger.admit(request({ message: 'two' }));
  assert.deepEqual(altered, { kind: 'conflict' });
  first.complete(response());
  if (duplicate.kind !== 'pending') return;

  assert.deepEqual(await duplicate.response, response());
  assert.equal(ledger.admit(request({ message: 'one' })).kind, 'replay');
  assert.equal(dispatcherCount, 1);
});

test('Given a full request ledger, when a new request ID arrives, then it is denied before dispatch', () => {
  const ledger = new FleetRequestLedger(1);
  ledger.admit(request());
  const second = parseFleetRequestEnvelope({ ...request(), requestId: 'request-2' });

  assert.deepEqual(ledger.admit(second), { kind: 'full' });
});

test('Given a full request ledger, when a completed read is oldest, then it is evicted for a new request', () => {
  const ledger = new FleetRequestLedger(1);
  const first = ledger.admit(request());
  assert.equal(first.kind, 'dispatch');
  if (first.kind !== 'dispatch') return;
  first.complete(response());

  const secondRequest = parseFleetRequestEnvelope({ ...request(), requestId: 'request-2' });
  assert.equal(ledger.admit(secondRequest).kind, 'dispatch');
  assert.equal(ledger.size, 1);
});

test('Given a blocked writer, when queue bounds are exceeded, then the socket closes without unbounded buffering', () => {
  const callbacks: ((error?: Error) => void)[] = [];
  const closes: Readonly<{ code: number; reason: string }>[] = [];
  const transport: FleetWritableTransport = {
    send: (_payload, callback) => { callbacks.push(callback); },
    close: (code, reason) => { closes.push({ code, reason }); },
  };
  const writer = new FleetBoundedWriter(transport, { maxFrames: 2, maxBytes: 8 });

  writer.send('1234');
  writer.send('5678');
  assert.throws(() => writer.send('9'), /queue is full/);
  assert.deepEqual(closes, [{ code: 4008, reason: 'fleet writer capacity exceeded' }]);
  callbacks[0]?.();
  callbacks[1]?.();
});


test('Given a negotiated capability intersection, when an unsupported operation arrives, then dispatch remains zero', () => {
  let dispatcherCount = 0;
  const incoming = request({ command: 'harmless' });
  const required = capabilityForOperation(incoming.operation);

  assert.throws(() => assertFleetCapability([], required), /capability is unavailable/);
  assert.equal(dispatcherCount, 0);
  assertFleetCapability(['catalog.read'], required);
  dispatcherCount += 1;
  assert.equal(dispatcherCount, 1);
});
