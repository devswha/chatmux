import {
  assertFleetRoleIntegrity,
  fleetCompletionOutboxDb,
  getConnection,
  userDb,
} from '@/modules/database/index.js';
import { FleetCatalogAggregator } from '@/modules/fleet/catalog/aggregator.js';
import { loadFleetPeerSigner } from '@/modules/fleet/peer/persistence.js';
import { FleetMutationClient } from '@/modules/fleet/rpc/mutations/index.js';
import { FleetReadClient } from '@/modules/fleet/rpc/reads/index.js';
import { RemoteTerminalClient, remoteTerminalShellGateway } from '@/modules/fleet/terminal/index.js';
import { wakeCompletionOutboxDispatcher } from '@/modules/notifications/index.js';
import { fleetSshTunnelManager } from '@/modules/fleet/services/ssh-tunnel.service.js';

import type { FleetCapability } from '../../../../../shared/fleet.js';
import { createFleetCompletionHubAdapter } from '../../completion/hub-adapter.js';
import type { FleetProtocolFrame } from '../../protocol/types.js';

import { SqliteHubPeerConnectionStore } from './persistence.js';
import { HubPeerConnectionRegistry } from './registry.js';
import type { HubConnectionScheduler } from './types.js';
import { dialFleetWebSocket } from './websocket-dialer.js';

const scheduler: HubConnectionScheduler = {
  get nowMs() { return Date.now(); },
  schedule: (delayMs, callback) => { const timer = setTimeout(callback, delayMs); timer.unref(); return { cancel: () => clearTimeout(timer) }; },
};

export async function createLocalFleetHubRuntime(processEpoch: string): Promise<Readonly<{
  readonly localHostId: string;
  readonly capabilities: readonly FleetCapability[];
  readonly registry: HubPeerConnectionRegistry;
  readonly catalog: FleetCatalogAggregator;
  readonly reads: FleetReadClient;
  readonly mutations: FleetMutationClient;
  readonly terminals: RemoteTerminalClient;
  readonly start: () => void;
  readonly stop: () => void;
}>> {
  const signer = await loadFleetPeerSigner();
  await fleetSshTunnelManager.restore();
  const peers = new SqliteHubPeerConnectionStore(getConnection());
  const capabilities: readonly FleetCapability[] = ['catalog.read', 'session.read', 'chat.control', 'prompt.respond', 'pane.read', 'terminal.attach', 'terminal.input', 'session.spawn', 'session.terminate', 'completion.event'];
  function requestSnapshot(hostId: string): void { registry.markSyncing(hostId); registry.requestCatalogSnapshot(hostId); }
  const catalog = new FleetCatalogAggregator(requestSnapshot);
  const completion = createFleetCompletionHubAdapter({
    status: (hostId) => registry.status(hostId),
    hostLabel: (hostId) => catalog.host(hostId)?.snapshot.host.displayLabel,
    ownerId: () => userDb.getFirstUser()?.id ?? null,
    record: (ownerId, event, now) => fleetCompletionOutboxDb.record(ownerId, event, now),
    wake: wakeCompletionOutboxDispatcher,
  });
  function onFrame(peerId: string, frame: FleetProtocolFrame): void {
    const status = registry.status(peerId);
    if (status === undefined || status.generation === null || status.peerProcessEpoch === null) return;
    if (frame.kind === 'event' && frame.event === 'catalog.snapshot') {
      if (catalog.snapshot(peerId, frame.connectionGeneration, status.peerProcessEpoch, frame.body).kind === 'applied') registry.markSynchronized(peerId);
    } else if (frame.kind === 'event' && frame.event === 'catalog.delta') {
      catalog.delta(peerId, frame.connectionGeneration, status.peerProcessEpoch, frame.body);
    } else if (frame.kind === 'response' && frame.requestId.startsWith('catalog-resync-') && frame.status === 'success') {
      if (catalog.snapshot(peerId, frame.connectionGeneration, status.peerProcessEpoch, frame.body).kind === 'applied') registry.markSynchronized(peerId);
    } else if (frame.kind === 'event' && frame.event === 'completion.ready') {
      completion.accept(peerId, frame.body);
    }
  }
  const registry = new HubPeerConnectionRegistry({
    peers, assertRoleIntegrity: () => assertFleetRoleIntegrity(getConnection()), local: { signer, processEpoch, capabilities }, requiredCapabilities: capabilities,
    scheduler, random: Math.random, dial: dialFleetWebSocket, onFrame,
    recordNegotiation: (status) => peers.recordNegotiation(status, scheduler.nowMs),
  });
  const reads = new FleetReadClient(registry);
  const mutations = new FleetMutationClient(registry);
  const terminals = new RemoteTerminalClient(registry);
  remoteTerminalShellGateway.bind(terminals);
  const unsubscribe = registry.subscribe((status) => {
    if (status.generation !== null && status.peerProcessEpoch !== null && catalog.host(status.peerId)?.generation !== status.generation) catalog.connected(status.peerId, status.generation, status.peerProcessEpoch);
    if (status.state === 'offline' || status.state === 'revoked' || status.state === 'incompatible') catalog.offline(status.peerId, status.state);
  });
  return { localHostId: signer.installationId, capabilities, registry, catalog, reads, mutations, terminals, start: () => registry.start(), stop: () => { fleetSshTunnelManager.stop(); remoteTerminalShellGateway.unbind(terminals); terminals.dispose(); unsubscribe(); registry.stop(); } };
}
