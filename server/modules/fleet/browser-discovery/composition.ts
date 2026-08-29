import { hostname } from 'node:os';

import { fleetPeersDb } from '@/modules/database/index.js';

import type { FleetCapability } from '../../../../shared/fleet.js';
import type { FleetCatalogAggregator } from '../catalog/aggregator.js';
import type { HubPeerConnectionRegistry } from '../hub/connection/registry.js';

import { createFleetBrowserDiscovery } from './browser-discovery.js';

export function createLocalFleetBrowserDiscovery(runtime: Readonly<{
  readonly localHostId: string;
  readonly capabilities: readonly FleetCapability[];
  readonly registry: HubPeerConnectionRegistry;
  readonly catalog: FleetCatalogAggregator;
}>) {
  return createFleetBrowserDiscovery({
    local: {
      hostId: runtime.localHostId,
      displayLabel: hostname(),
      capabilities: runtime.capabilities,
    },
    peers: {
      list: () => fleetPeersDb.list().map((peer) => ({
        peerId: peer.peerId,
        displayLabel: peer.displayLabel,
        enrollmentState: peer.enrollmentState,
      })),
    },
    registry: runtime.registry,
    catalog: runtime.catalog,
  });
}
