import type { DiscoveryCollector } from '@/modules/providers/index.js';

import type { FleetMutationClient } from '../rpc/mutations/index.js';
import { createLocalFleetReadServices, type FleetReadClient } from '../rpc/reads/index.js';
import type { RemoteTerminalClient } from '../terminal/index.js';
import type { HubPeerConnectionRegistry } from '../hub/connection/index.js';
import type { FleetProtocolFrame } from '../protocol/types.js';

import { FleetHostRouter } from './host-router.js';
import { createLocalFleetSpawnService, type LocalFleetSpawnService } from './local-spawn.js';

export type FleetApplicationClients = Readonly<{
  readonly reads: Pick<FleetReadClient,
    'metadata' | 'history' | 'search' | 'capturePane' | 'chatSubscription'
    | 'providerInventory' | 'prompt' | 'approval' | 'pathSuggestions'
  >;
  readonly mutations: Pick<FleetMutationClient,
    | 'sendChat' | 'abortChat' | 'respondPrompt' | 'respondApproval' | 'spawn'
    | 'sendPane' | 'interrupt' | 'escape'
    | 'terminateProcess' | 'terminatePane' | 'terminateSession'
  >;
  readonly terminals: Pick<RemoteTerminalClient, 'attach'>;
}>;
export type FleetApplicationRouting = Readonly<{
  readonly router: FleetHostRouter<FleetApplicationClients>;
  readonly localReads: ReturnType<typeof createLocalFleetReadServices>;
  readonly localSpawn: LocalFleetSpawnService;
  readonly subscribeFrames: (
    listener: (hostId: string, frame: FleetProtocolFrame) => void,
  ) => () => void;
}>;

type FleetHubApplicationRuntime = FleetApplicationClients & Readonly<{
  readonly localHostId: string;
  readonly registry: HubPeerConnectionRegistry;
}>;

class FleetApplicationRoutingProvider {
  private currentValue: FleetApplicationRouting | undefined;

  bind(runtime: FleetHubApplicationRuntime, discovery: DiscoveryCollector): FleetApplicationRouting {
    const value = {
      router: new FleetHostRouter({
        localHostId: runtime.localHostId,
        clients: { reads: runtime.reads, mutations: runtime.mutations, terminals: runtime.terminals },
        status: (hostId: string) => runtime.registry.status(hostId),
      }),
      localReads: createLocalFleetReadServices(discovery),
      localSpawn: createLocalFleetSpawnService(),
      subscribeFrames: (listener: (hostId: string, frame: FleetProtocolFrame) => void) => runtime.registry.subscribeFrames(listener),
    };
    this.currentValue = value;
    return value;
  }

  current(): FleetApplicationRouting | undefined { return this.currentValue; }
  unbind(value: FleetApplicationRouting): void { if (this.currentValue === value) this.currentValue = undefined; }
}

export const fleetApplicationRouting = new FleetApplicationRoutingProvider();
