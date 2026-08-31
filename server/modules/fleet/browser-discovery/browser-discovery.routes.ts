import type { IncomingMessage } from 'node:http';

import express, { type Request } from 'express';

import { authorizeFleetOwner } from '../services/fleet-owner-authorization.service.js';

import { fleetBrowserDiscoveryGateway } from './gateway.js';

export type FleetBrowserAuthMode = 'none' | 'password' | 'tailscale';

type BrowserPrincipal = Readonly<{ readonly id?: number; readonly tailscaleRole?: string }>;
type FleetBrowserRequest = IncomingMessage & Readonly<{
  readonly user?: Readonly<{
    readonly id?: string | number;
    readonly userId?: string | number;
    readonly username?: string;
    readonly tailscaleRole?: string;
  }>;
}>;

function principal(value: unknown): BrowserPrincipal | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const directId = 'id' in value && typeof value.id === 'number' ? value.id : undefined;
  const userId = 'userId' in value && typeof value.userId === 'number' ? value.userId : undefined;
  const id = directId ?? userId;
  const tailscaleRole = 'tailscaleRole' in value && typeof value.tailscaleRole === 'string'
    ? value.tailscaleRole
    : undefined;
  if (id !== undefined && tailscaleRole !== undefined) return { id, tailscaleRole };
  if (id !== undefined) return { id };
  return tailscaleRole === undefined ? undefined : { tailscaleRole };
}

export function authorizeFleetBrowserRequest(
  request: FleetBrowserRequest,
  authMode: FleetBrowserAuthMode,
): boolean {
  return authorizeFleetOwner({
    authMode,
    principal: principal(request.user),
    remoteAddress: request.socket.remoteAddress,
  }).authorized;
}

export function createFleetBrowserDiscoveryRouter(authMode: FleetBrowserAuthMode) {
  const router = express.Router();
  router.get('/fleet/identity', (request: Request, response) => {
    if (!authorizeFleetBrowserRequest(request, authMode)) {
      response.status(403).json({ error: 'owner_required' });
      return;
    }
    const authority = fleetBrowserDiscoveryGateway.current();
    const local = authority?.hosts()[0];
    if (local === undefined) {
      response.status(404).json({ error: 'fleet_unavailable' });
      return;
    }
    response.json({ data: { installationId: local.hostId } });
  });
  router.get('/fleet/hosts', (request: Request, response) => {
    if (!authorizeFleetBrowserRequest(request, authMode)) {
      response.status(403).json({ error: 'owner_required' });
      return;
    }
    const authority = fleetBrowserDiscoveryGateway.current();
    if (authority === undefined) {
      response.status(404).json({ error: 'fleet_unavailable' });
      return;
    }
    const hosts = authority.hosts();
    response.json({ data: { localHostId: hosts[0]?.hostId ?? null, hosts } });
  });
  return router;
}
