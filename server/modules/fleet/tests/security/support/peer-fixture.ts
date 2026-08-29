import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';

import Database from 'better-sqlite3';

import {
  createFleetMutationHandlers,
  createPersistedMutationAuthority,
  FleetMutationRpcError,
  type FleetMutationServices,
} from '@/modules/fleet/rpc/mutations/index.js';
import { createFleetReadHandlers } from '@/modules/fleet/rpc/reads/index.js';
import type { FleetReadServices } from '@/modules/fleet/rpc/reads/peer.js';
import { SqliteFleetPairingStore } from '@/modules/fleet/services/fleet-pairing-store.service.js';

import type { FleetCapability, FleetResponseEnvelope, FleetRequestEnvelope, JsonValue } from '../../../../../../shared/fleet.js';
import { createFleetPeerEndpoint } from '../../../peer/endpoint.js';
import {
  createPeerOperationDispatcher,
  derivePeerCapabilities,
  type PeerOperationHandlers,
} from '../../../peer/operation-dispatcher.js';
import { SqliteFleetGenerationStore, SqliteFleetPeerTrustStore } from '../../../peer/persistence.js';
import { FleetConnectionRegistry } from '../../../protocol/state-machine.js';

import { PEER_SECURITY_SCHEMA_SQL, type TestInstallation } from './identities.js';

export const FIXTURE_SESSION = 'session-1' as const;
export const FIXTURE_PROJECT = 'project-1' as const;
const VERIFIED: Readonly<{ readonly token: string }> = { token: 'fixture-verified' };

export type FixtureAction = Readonly<{ readonly operation: string; readonly target: string }>;

/** Real RPC-to-local-verifier chain; only the tmux action seam is instrumented. */
export type FixtureChain = Readonly<{
  readonly dispatch: (request: FleetRequestEnvelope) => Promise<FleetResponseEnvelope>;
  readonly capabilities: readonly FleetCapability[];
  readonly actionLog: FixtureAction[];
  readonly dispatchLog: string[];
  readonly readLog: string[];
}>;

export type ChainOptions = Readonly<{
  readonly hostId: string;
  readonly db: Database.Database;
  readonly operations: 'full' | 'catalog';
  readonly gate?: Readonly<{ readonly beforeRead: () => Promise<void> }>;
  readonly clock?: () => number;
}>;

function fixtureReadServices(readLog: string[]): FleetReadServices {
  const record = (name: string): void => { readLog.push(name); };
  return {
    sessionMetadata: async () => { record('sessionMetadata'); return { sessionId: FIXTURE_SESSION }; },
    history: async () => { record('history'); return { messages: [] }; },
    search: async () => { record('search'); return { results: [] }; },
    prompt: async () => { record('prompt'); return null; },
    approval: async () => { record('approval'); return null; },
    capturePane: async () => { record('capturePane'); return { output: 'fixture-pane' }; },
    providerInventory: async () => {
      record('providerInventory');
      return {
        provider: 'fixture-agent', label: 'visible',
        home: '/home/peer-secret', sourcePath: '/var/lib/secret.jsonl', jsonlPath: '/x/secret',
        transcriptPath: '/y/secret', socketPath: '/tmp/tmux-secret', diagnostic: 'secret-diagnostic',
        details: { nested: 'secret-detail' },
      };
    },
    chatSubscription: async () => { record('chatSubscription'); return { events: [] }; },
    pathSuggestions: async () => { record('pathSuggestions'); return ['/visible']; },
  };
}

export function createFixtureChain(options: ChainOptions): FixtureChain {
  const clock = options.clock ?? (() => 1_000);
  const authority = createPersistedMutationAuthority({
    db: options.db,
    localHostId: options.hostId,
    beforeRead: options.gate?.beforeRead,
  });
  const actionLog: FixtureAction[] = [];
  const dispatchLog: string[] = [];
  const readLog: string[] = [];
  const act = (operation: string) => async (): Promise<void> => {
    actionLog.push({ operation, target: VERIFIED.token });
  };
  const services: FleetMutationServices = {
    verifySession: async (localId) => {
      if (localId !== FIXTURE_SESSION) throw new FleetMutationRpcError('HOST_NOT_FOUND', 'session was not found');
      return VERIFIED;
    },
    verifyPane: async () => VERIFIED,
    verifySpawn: async (projectLocalId) => {
      if (projectLocalId !== FIXTURE_PROJECT) throw new FleetMutationRpcError('HOST_NOT_FOUND', 'project was not found');
      return { cwd: '/home/peer/project' };
    },
    finalCheck: (request) => authority.assertCurrent(request),
    send: act('send'), abort: act('abort'), interrupt: act('interrupt'), escape: act('escape'),
    respondPrompt: async () => { actionLog.push({ operation: 'respondPrompt', target: VERIFIED.token }); return null; },
    respondApproval: act('respondApproval'),
    spawn: async (): Promise<JsonValue> => { actionLog.push({ operation: 'spawn', target: VERIFIED.token }); return null; },
    terminateProcess: act('terminateProcess'), terminatePane: act('terminatePane'), terminateSession: act('terminateSession'),
  };
  const handlers: PeerOperationHandlers = options.operations === 'catalog'
    ? { 'catalog.snapshot': async () => ({ hosts: [] }) }
    : {
      'catalog.snapshot': async () => ({ hosts: [] }),
      ...createFleetReadHandlers(options.hostId, fixtureReadServices(readLog), clock),
      ...createFleetMutationHandlers(options.hostId, services, clock),
    };
  const dispatch = createPeerOperationDispatcher(options.hostId, handlers);
  return {
    dispatch: async (request) => { dispatchLog.push(request.operation); return dispatch(request); },
    capabilities: derivePeerCapabilities(handlers, []),
    actionLog, dispatchLog, readLog,
  };
}

export type PeerOptions = Readonly<{
  readonly identity: TestInstallation;
  readonly hub: TestInstallation;
  readonly processEpoch?: string;
  readonly operations?: 'full' | 'catalog';
  readonly gate?: Readonly<{ readonly beforeRead: () => Promise<void> }>;
  readonly dbFile?: string;
  readonly port?: number;
}>;

export type StartedPeer = Readonly<{
  readonly port: number;
  readonly hostId: string;
  readonly db: Database.Database;
  readonly store: SqliteFleetPairingStore;
  readonly chain: FixtureChain;
  readonly authLog: string[];
  generation(): number;
  stop(): Promise<void>;
}>;

export function persistedGeneration(db: Database.Database, hostId: string): number {
  const row = db
    .prepare<[string], Readonly<{ value: unknown }>>('SELECT value FROM app_config WHERE key = ?')
    .get(`fleet.peer.connection-generation.${hostId}`);
  return row === undefined ? 0 : Number(row.value);
}

export async function startPeer(options: PeerOptions): Promise<StartedPeer> {
  const hostId = options.identity.signer.installationId;
  const db = new Database(options.dbFile ?? ':memory:');
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
  if (enrolled.kind === 'active_grant_exists') {
    const pinned = await new SqliteFleetPeerTrustStore(db, hostId).find(options.hub.signer.installationId);
    if (pinned?.state !== 'active' || pinned.pinnedPublicKey !== options.hub.publicKey) {
      throw new TypeError('fixture hub enrollment conflicts with the persisted grant');
    }
  } else if (enrolled.kind !== 'enrolled') {
    throw new TypeError('fixture hub enrollment failed');
  }
  const chain = createFixtureChain({
    hostId, db, operations: options.operations ?? 'full', gate: options.gate,
  });
  const authLog: string[] = [];
  const server: Server = createServer();
  const endpoint = createFleetPeerEndpoint({
    server,
    browserUpgradeListeners: [],
    local: {
      role: 'peer', signer: options.identity.signer,
      processEpoch: options.processEpoch ?? 'peer-epoch-1',
      capabilities: chain.capabilities, transportMode: 'ssh-loopback',
    },
    trust: new SqliteFleetPeerTrustStore(db, hostId),
    registry: new FleetConnectionRegistry(new SqliteFleetGenerationStore(db, hostId)),
    dispatch: chain.dispatch,
    onAuthenticated: (connection) => {
      authLog.push(`${connection.remoteInstallationId}#${connection.generation}`);
    },
  });
  endpoint.start();
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new TypeError('peer fixture has no TCP address');
  let stopped = false;
  return {
    port: address.port, hostId, db, store, chain, authLog,
    generation: () => persistedGeneration(db, hostId),
    stop: async () => {
      if (stopped) return;
      stopped = true;
      await endpoint.stop();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
      db.close();
    },
  };
}
