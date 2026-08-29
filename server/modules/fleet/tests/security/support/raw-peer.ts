import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';

import Database from 'better-sqlite3';
import { WebSocketServer, type RawData, type VerifyClientCallbackSync, type WebSocket } from 'ws';

import { SqliteFleetPairingStore } from '@/modules/fleet/services/fleet-pairing-store.service.js';

import { FleetChallengeReplayGuard } from '../../../protocol/auth.js';
import type { FleetWritableTransport, FleetWriterOptions } from '../../../protocol/bounded-writer.js';
import { FleetProtocolConnection } from '../../../protocol/connection.js';
import type { FleetProtocolErrorCode } from '../../../protocol/errors.js';
import { FleetConnectionRegistry } from '../../../protocol/state-machine.js';
import { validateFleetUpgrade } from '../../../protocol/transport-policy.js';
import { SqliteFleetGenerationStore, SqliteFleetPeerTrustStore } from '../../../peer/persistence.js';

import { PEER_SECURITY_SCHEMA_SQL, type TestInstallation } from './identities.js';
import { createFixtureChain, type FixtureChain } from './peer-fixture.js';

export type RawPeerOptions = Readonly<{
  readonly identity: TestInstallation;
  readonly hub: TestInstallation;
  readonly writer?: FleetWriterOptions;
  readonly requestCapacity?: number;
  readonly holdSendCallbacks?: boolean;
  readonly gate?: Readonly<{ readonly beforeRead: () => Promise<void> }>;
}>;

export type StartedRawPeer = Readonly<{
  readonly port: number;
  readonly hostId: string;
  readonly chain: FixtureChain;
  readonly errors: FleetProtocolErrorCode[];
  releaseSends(): void;
  stop(): Promise<void>;
}>;

/**
 * Real FleetProtocolConnection over a real WebSocket with the real DB-backed trust,
 * generation, dispatch, and persisted verifier; only transport knobs are configured.
 */
export async function startRawPeer(options: RawPeerOptions): Promise<StartedRawPeer> {
  const hostId = options.identity.signer.installationId;
  const db = new Database(':memory:');
  db.exec(PEER_SECURITY_SCHEMA_SQL);
  const store = new SqliteFleetPairingStore(db);
  const enrollmentToken = randomBytes(32);
  store.issue(enrollmentToken, 600_000, 1_000);
  const enrolled = store.consumeAndPin(enrollmentToken, {
    peerId: hostId,
    hubInstallationId: options.hub.signer.installationId,
    pinnedPublicKey: options.hub.publicKey,
    pinnedPublicKeyFingerprint: options.hub.fingerprint,
    revokedAtMs: null,
  }, 1_001);
  if (enrolled.kind !== 'enrolled') throw new TypeError('fixture hub enrollment failed');
  const chain = createFixtureChain({ hostId, db, operations: 'full', gate: options.gate });
  // Held send callbacks: deterministic writer backpressure is their documented purpose.
  const held: (() => void)[] = [];
  const errors: FleetProtocolErrorCode[] = [];
  const server: Server = createServer();
  const wss = new WebSocketServer({
    server,
    verifyClient: (info: Parameters<VerifyClientCallbackSync>[0]) =>
      validateFleetUpgrade({ url: info.req.url, headers: info.req.headers }).ok,
  });
  wss.on('connection', (socket: WebSocket) => {
    const transport: FleetWritableTransport = {
      send: (payload, callback) => {
        socket.send(payload, (error) => {
          const done = (): void => callback(error ?? undefined);
          if (options.holdSendCallbacks === true) held.push(done);
          else done();
        });
      },
      close: (code, reason) => socket.close(code, reason),
    };
    const connection = new FleetProtocolConnection({
      local: {
        role: 'peer', signer: options.identity.signer, processEpoch: randomUUID(),
        capabilities: chain.capabilities, transportMode: 'ssh-loopback',
      },
      trust: new SqliteFleetPeerTrustStore(db, hostId),
      replayGuard: new FleetChallengeReplayGuard(),
      registry: new FleetConnectionRegistry(new SqliteFleetGenerationStore(db, hostId)),
      transport,
      dispatch: chain.dispatch,
      onError: (code) => { errors.push(code); },
      writer: options.writer,
      requestCapacity: options.requestCapacity,
    });
    socket.on('message', (raw: RawData) => { void connection.receive(raw); });
    socket.on('close', () => connection.stop());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new TypeError('raw peer has no TCP address');
  let stopped = false;
  return {
    port: address.port, hostId, chain, errors,
    releaseSends: () => { for (const done of held.splice(0)) done(); },
    stop: async () => {
      if (stopped) return;
      stopped = true;
      for (const done of held.splice(0)) done();
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve, reject) => {
        wss.close((error) => (error === undefined ? resolve() : reject(error)));
      });
      await new Promise<void>((resolve, reject) => {
        server.close((closeError) => (closeError === undefined ? resolve() : reject(closeError)));
      });
      db.close();
    },
  };
}
