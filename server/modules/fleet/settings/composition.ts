import express from 'express';

import { fleetInstallationRole, fleetPeersDb, getConnection } from '@/modules/database/index.js';
import { createFleetPairingRouter } from '@/modules/fleet/fleet-pairing.routes.js';
import { fleetBrowserDiscoveryGateway } from '@/modules/fleet/browser-discovery/index.js';
import { loadFleetSignedIdentity } from '@/modules/fleet/peer/persistence.js';
import { fleetPeerRevocationGateway } from '@/modules/fleet/peer/revocation-gateway.js';
import { FleetHubPairingService } from '@/modules/fleet/services/fleet-hub-pairing.service.js';
import { FleetPairingFailureLimiter } from '@/modules/fleet/services/fleet-pairing-limiter.service.js';
import { FleetPairingService } from '@/modules/fleet/services/fleet-pairing.service.js';
import { SqliteFleetPairingStore } from '@/modules/fleet/services/fleet-pairing-store.service.js';
import { FleetRevocationService } from '@/modules/fleet/services/fleet-revocation.service.js';
import { loadOrCreateInstallationIdentity } from '@/modules/fleet/services/installation-identity.service.js';

import { createFleetPairingTransport } from './fleet-pairing-transport.js';
import { createFleetSettingsRouter } from './fleet-settings.routes.js';

type AuthMode = 'none' | 'password' | 'tailscale';

type Services = Readonly<{
  readonly pairing: FleetPairingService;
  readonly hubPairing: FleetHubPairingService;
  readonly revocation: FleetRevocationService;
}>;

let servicesPromise: Promise<Services> | undefined;

async function services(): Promise<Services> {
  servicesPromise ??= (async () => {
    const identity = await loadFleetSignedIdentity();
    const transport = createFleetPairingTransport();
    return {
      pairing: new FleetPairingService({
        store: new SqliteFleetPairingStore(getConnection()),
        identity,
      }),
      hubPairing: new FleetHubPairingService({
        identity,
        peers: fleetPeersDb,
        transport,
        activeInboundGrant: () => fleetPeersDb.hasActiveInboundGrant(),
      }),
      revocation: new FleetRevocationService({
        identity,
        peers: fleetPeersDb,
        transport,
      }),
    };
  })();
  return servicesPromise;
}

export function createLocalFleetSettingsRouter(authMode: AuthMode): express.Router {
  const router = express.Router();
  const limiter = new FleetPairingFailureLimiter();
  router.use(createFleetPairingRouter({
    authMode,
    limiter,
    pairing: {
      issueToken: async () => (await services()).pairing.issueToken(),
      redeem: async (input) => (await services()).pairing.redeem(input),
      revokeHubGrant: async (hub) => {
        const revoked = (await services()).pairing.revokeHubGrant(hub);
        // The durable grant is gone; drop the live hub connection as well so
        // reads, terminal streams and events stop now, not at the next tick.
        if (revoked) fleetPeerRevocationGateway.notifyRevoked();
        return revoked;
      },
    },
    hubPairing: {
      enroll: async (input) => {
        const result = await (await services()).hubPairing.enroll(input);
        fleetBrowserDiscoveryGateway.current()?.reconcile();
        return result;
      },
    },
    revocation: {
      remove: async (peerId) => {
        const result = await (await services()).revocation.remove(peerId);
        fleetBrowserDiscoveryGateway.current()?.reconcile();
        return result;
      },
    },
  }));
  router.use(createFleetSettingsRouter({
    authMode,
    identity: loadOrCreateInstallationIdentity,
    peers: () => fleetPeersDb.list(),
    role: () => fleetInstallationRole(getConnection()),
    statuses: () => fleetBrowserDiscoveryGateway.current()?.statuses() ?? [],
    reconnect: (peerId) => fleetBrowserDiscoveryGateway.current()?.reconnect(peerId) ?? false,
    forget: (peerId) => fleetPeersDb.removeRevoked(peerId),
  }));
  return router;
}
