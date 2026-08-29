import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';

import { WebSocket, WebSocketServer, type RawData } from 'ws';

import { FleetChallengeReplayGuard, type FleetIdentitySigner } from '../protocol/auth.js';
import type { FleetWritableTransport } from '../protocol/bounded-writer.js';
import { FleetProtocolConnection } from '../protocol/connection.js';
import type { FleetProtocolScheduler } from '../protocol/connection-types.js';
import { FleetConnectionRegistry, type FleetGenerationStore } from '../protocol/state-machine.js';

class GenerationStore implements FleetGenerationStore {
  async claimNext(): Promise<number> { return 1; }
}

class ManualScheduler implements FleetProtocolScheduler {
  nowMs = 1;
  callback: (() => void) | undefined;
  now(): number { return this.nowMs; }
  schedule(delayMs: number, callback: () => void) {
    const dueAt = this.nowMs + delayMs;
    this.callback = () => { this.nowMs = dueAt; callback(); };
    return { cancel: () => { this.callback = undefined; } };
  }
  advance(): void { this.callback?.(); }
}

function identity(): FleetIdentitySigner {
  const keys = generateKeyPairSync('ed25519');
  return {
    installationId: randomUUID(),
    sign: async (challenge) => sign(null, challenge, keys.privateKey),
  };
}

test('Given a real idle WebSocket, when the composed auth deadline reaches five seconds, then it closes redacted', async (context) => {
  const scheduler = new ManualScheduler();
  const created = Promise.withResolvers<void>();
  const errors: string[] = [];
  const server = createServer();
  const wss = new WebSocketServer({ server });
  context.after(async () => {
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  wss.on('connection', (socket) => {
    const transport: FleetWritableTransport = {
      send: (payload, callback) => socket.send(payload, (error) => callback(error ?? undefined)),
      close: (code, reason) => socket.close(code, reason),
    };
    const connection = new FleetProtocolConnection({
      local: { role: 'peer', signer: identity(), processEpoch: 'peer-epoch', capabilities: ['catalog.read'], transportMode: 'direct-wss' },
      trust: { find: async () => undefined }, replayGuard: new FleetChallengeReplayGuard(),
      registry: new FleetConnectionRegistry(new GenerationStore()), transport, scheduler,
      dispatch: async () => { throw new TypeError('deadline test must not dispatch'); },
      onError: (code) => { errors.push(code); },
    });
    socket.on('message', (raw: RawData) => { void connection.receive(raw); });
    socket.on('close', () => connection.stop());
    created.resolve();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new TypeError('test server has no TCP address');
  const client = new WebSocket(`ws://127.0.0.1:${address.port}/fleet-ws`);
  await once(client, 'open');
  await created.promise;
  const closed = new Promise<Readonly<{ code: number; reason: string }>>((resolve) => {
    client.once('close', (code: number, reason: Buffer) => resolve({ code, reason: reason.toString() }));
  });

  scheduler.advance();

  assert.deepEqual(await closed, { code: 4003, reason: 'fleet authentication rejected' });
  assert.deepEqual(errors, ['AUTH_DEADLINE_EXCEEDED']);
});
