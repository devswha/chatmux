import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import type { Server as HttpServer } from 'node:http';

import { getConnection } from '@/modules/database/index.js';
import type { DiscoveryCollector } from '@/modules/providers/index.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';

import type { JsonValue } from '../../../../shared/fleet.js';
import { FleetConnectionRegistry } from '../protocol/state-machine.js';
import { FleetCompletionPeerPublisher, fleetCompletionPeerGateway } from '../completion/peer-publisher.js';
import { createFleetMutationHandlers, createLocalFleetMutationServices } from '../rpc/mutations/index.js';
import { createFleetReadHandlers, createLocalFleetReadServices } from '../rpc/reads/index.js';
import {
  createRemoteTerminalPeer, registerRemoteTerminalHandlers,
} from '../terminal/index.js';
import { spawnLocalRemoteTerminal, verifyLocalRemoteTerminalTarget } from '../terminal/local-peer.js';

import { PeerCatalogPublisher } from './catalog-publisher.js';
import { createPeerCatalogSource } from './catalog-source.js';
import { createFleetPeerEndpoint, type UpgradeListener } from './endpoint.js';
import { createPeerOperationDispatcher } from './operation-dispatcher.js';
import {
  loadFleetPeerSigner,
  SqliteFleetGenerationStore,
  SqliteFleetPeerTrustStore,
} from './persistence.js';

function json(value: unknown): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map(json);
  if (typeof value !== 'object') return null;
  return Object.fromEntries(
    Object.entries(value).filter((entry) => entry[1] !== undefined).map(([key, item]) => [key, json(item)]),
  );
}

type LocalFleetPeerOptions = Readonly<{
  readonly server: HttpServer;
  readonly browserUpgradeListeners: readonly UpgradeListener[];
  readonly discovery: DiscoveryCollector;
  readonly processEpoch: string;
  readonly transportMode: 'direct-wss' | 'ssh-loopback';
}>;

export async function createLocalFleetPeerRuntime(options: LocalFleetPeerOptions) {
  const signer = await loadFleetPeerSigner();
  const capabilities = ['catalog.read', 'session.read', 'chat.control', 'prompt.respond', 'pane.read', 'terminal.attach', 'terminal.input', 'session.spawn', 'session.terminate', 'completion.event'] as const;
  const displayLabel = hostname();
  const source = createPeerCatalogSource({ hostId: signer.installationId, displayLabel, capabilities, discovery: options.discovery });
  const publisher = new PeerCatalogPublisher({ epoch: options.processEpoch, read: source.read, subscribe: source.subscribe });
  const db = getConnection();
  const activeGenerations = new Set<number>();
  const terminal = createRemoteTerminalPeer({
    hostId: signer.installationId, processEpoch: options.processEpoch, now: Date.now,
    isConnectionCurrent: (generation) => activeGenerations.has(generation),
    verifyTarget: verifyLocalRemoteTerminalTarget, spawn: spawnLocalRemoteTerminal,
    publish: (event, body) => endpoint.publish(event, 'terminal-' + randomUUID(), body),
  });
  const mutations = createFleetMutationHandlers(signer.installationId, createLocalFleetMutationServices(signer.installationId, options.discovery, db));
  const handlers = registerRemoteTerminalHandlers({
    'catalog.snapshot': async () => publisher.snapshotBody(),
    ...createFleetReadHandlers(signer.installationId, createLocalFleetReadServices(options.discovery)),
    ...mutations,
  }, terminal.handlers);
  const endpoint = createFleetPeerEndpoint({
    server: options.server,
    browserUpgradeListeners: options.browserUpgradeListeners,
    local: {
      role: 'peer', signer, processEpoch: options.processEpoch,
      capabilities, transportMode: options.transportMode,
    },
    trust: new SqliteFleetPeerTrustStore(db, signer.installationId),
    registry: new FleetConnectionRegistry(new SqliteFleetGenerationStore(db, signer.installationId)),
    dispatch: createPeerOperationDispatcher(signer.installationId, handlers),
    catalogPublisher: publisher,
    onAuthenticated: ({ generation }) => activeGenerations.add(generation),
    onDisconnected: ({ generation }) => { activeGenerations.delete(generation); terminal.closeGeneration(generation); },
  });
  const releaseChatEvents = chatRunRegistry.subscribeEvents((event) => {
    endpoint.publish('chat.delta', `chat-${randomUUID()}`, json(event));
  });
  const completionPublisher = new FleetCompletionPeerPublisher(signer.installationId, displayLabel);
  const releaseCompletionGateway = fleetCompletionPeerGateway.bind(completionPublisher);
  const releaseCompletionEvents = completionPublisher.subscribe((event) => {
    endpoint.publish('completion.ready', `completion-${randomUUID()}`, json(event));
  });
  return {
    capabilities,
    start: endpoint.start,
    stop: async () => {
      releaseCompletionGateway();
      releaseCompletionEvents();
      releaseChatEvents();
      terminal.dispose();
      await endpoint.stop();
      publisher.stop();
    },
  };
}
