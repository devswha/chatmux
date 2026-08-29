import { AppError } from '@/shared/utils.js';

import { fleetErrorStatus, type FleetErrorCode, type FleetOperation } from '../../../../shared/fleet.js';
import { capabilityForOperation } from '../protocol/capabilities.js';
import type { HubPeerStatus } from '../hub/connection/types.js';

const INSTALLATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type FleetHostClients = object;
export type FleetRoutingPrincipal = Readonly<{ readonly id: string; readonly owner: boolean }>;
export type FleetHostResolveRequest = Readonly<{
  readonly hostId: string | undefined;
  readonly principal: FleetRoutingPrincipal;
}>;
export type FleetHostRouteRequest = FleetHostResolveRequest & Readonly<{
  readonly operation: FleetOperation;
}>;
export type FleetHostRoute<TClients extends FleetHostClients> =
  | Readonly<{ readonly kind: 'local'; readonly hostId: string }>
  | Readonly<{ readonly kind: 'remote'; readonly hostId: string; readonly clients: TClients; readonly status: HubPeerStatus }>;

export class FleetHostRoutingError extends AppError {
  readonly name = 'FleetHostRoutingError';

  constructor(code: FleetErrorCode, message: string) {
    super(message, { code, statusCode: fleetErrorStatus(code) });
  }
}

function unavailable(status: HubPeerStatus): FleetHostRoutingError | null {
  switch (status.state) {
    case 'online':
      return status.generation === null || status.peerProcessEpoch === null
        ? new FleetHostRoutingError('HOST_SYNCING', 'Fleet host is synchronizing.')
        : null;
    case 'connecting':
    case 'syncing':
      return new FleetHostRoutingError('HOST_SYNCING', 'Fleet host is synchronizing.');
    case 'degraded':
    case 'offline':
      return new FleetHostRoutingError('HOST_OFFLINE', 'Fleet host is offline.');
    case 'revoked':
      return new FleetHostRoutingError('HOST_REVOKED', 'Fleet host was revoked.');
    case 'incompatible':
      return new FleetHostRoutingError('HOST_INCOMPATIBLE', 'Fleet host is incompatible.');
  }
}

export class FleetHostRouter<TClients extends FleetHostClients = FleetHostClients> {
  constructor(private readonly options: Readonly<{
    readonly localHostId: string;
    readonly clients: TClients;
    readonly status: (hostId: string) => HubPeerStatus | undefined;
  }>) {}

  resolve(request: FleetHostResolveRequest): FleetHostRoute<TClients> {
    if (request.hostId === undefined || request.hostId === this.options.localHostId) {
      return { kind: 'local', hostId: this.options.localHostId };
    }
    if (!request.principal.owner) {
      throw new FleetHostRoutingError('FLEET_UNAUTHORIZED', 'Fleet owner access is required.');
    }
    if (!INSTALLATION_ID.test(request.hostId)) {
      throw new FleetHostRoutingError('HOST_NOT_FOUND', 'Fleet host was not found.');
    }
    const status = this.options.status(request.hostId);
    if (status === undefined || status.peerId !== request.hostId) {
      throw new FleetHostRoutingError('HOST_NOT_FOUND', 'Fleet host was not found.');
    }
    const blocked = unavailable(status);
    if (blocked !== null) throw blocked;
    return { kind: 'remote', hostId: request.hostId, clients: this.options.clients, status };
  }

  admit(selected: FleetHostRoute<TClients>, operation: FleetOperation): FleetHostRoute<TClients> {
    if (selected.kind === 'local') return selected;
    if (!selected.status.capabilities.includes(capabilityForOperation(operation))) {
      throw new FleetHostRoutingError('FLEET_CAPABILITY_UNAVAILABLE', 'Fleet capability is unavailable.');
    }
    return selected;
  }

  route(request: FleetHostRouteRequest): FleetHostRoute<TClients> {
    return this.admit(this.resolve(request), request.operation);
  }
}
