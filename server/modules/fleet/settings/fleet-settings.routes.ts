import express from 'express';
import type { Request, RequestHandler } from 'express';

import type { FleetInstallationRole, FleetPeer } from '@/modules/database/index.js';
import { authorizeFleetOwner } from '@/modules/fleet/services/fleet-owner-authorization.service.js';
import type { InstallationPublicIdentity } from '@/modules/fleet/services/installation-identity.service.js';
import type { SshCandidatesPayload } from '@/modules/fleet/services/ssh-candidates.service.js';
import type { HubPeerStatus } from '@/modules/fleet/hub/connection/types.js';

import { FLEET_MAX_REMOTE_PEERS } from '../../../../shared/fleet.js';

type AuthMode = 'none' | 'password' | 'tailscale';
type ForgetResult = 'removed' | 'not_found' | 'peer_active';
type SettingsPeer = Pick<FleetPeer,
  'peerId' | 'displayLabel' | 'transportMode' | 'enrollmentState' | 'negotiatedProtocol'
  | 'negotiatedCapabilities' | 'lastSeenAtMs' | 'pinnedPublicKeyFingerprint'
>;
type FleetSettingsDependencies = Readonly<{
  readonly authMode: AuthMode;
  readonly identity: () => Promise<InstallationPublicIdentity>;
  readonly peers: () => readonly SettingsPeer[];
  readonly role: () => FleetInstallationRole;
  readonly statuses: () => readonly HubPeerStatus[];
  readonly reconnect: (peerId: string) => boolean;
  readonly forget: (peerId: string) => ForgetResult;
  readonly sshCandidates: () => Promise<SshCandidatesPayload>;
}>;

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function principal(request: Request): Readonly<{ id?: number; tailscaleRole?: string }> | undefined {
  if (!('user' in request)) return undefined;
  const value = request.user;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const id = 'id' in value && typeof value.id === 'number' ? value.id : undefined;
  const tailscaleRole = 'tailscaleRole' in value && typeof value.tailscaleRole === 'string'
    ? value.tailscaleRole
    : undefined;
  return id === undefined && tailscaleRole === undefined ? undefined : {
    ...(id === undefined ? {} : { id }),
    ...(tailscaleRole === undefined ? {} : { tailscaleRole }),
  };
}

function requireOwner(authMode: AuthMode): RequestHandler {
  return (request, response, next) => {
    const decision = authorizeFleetOwner({
      authMode,
      principal: principal(request),
      remoteAddress: request.socket.remoteAddress,
    });
    if (!decision.authorized) {
      response.status(403).json({ error: 'owner_required' });
      return;
    }
    next();
  };
}

function peerId(request: Request): string | null {
  const value = request.params.peerId;
  return value !== undefined && UUID_V4.test(value) ? value : null;
}

function publicPeer(peer: SettingsPeer, status: HubPeerStatus | undefined) {
  return {
    peerId: peer.peerId,
    displayLabel: peer.displayLabel,
    transportMode: peer.transportMode,
    enrollmentState: peer.enrollmentState,
    state: peer.enrollmentState === 'revoked' ? 'revoked' : status?.state ?? 'offline',
    protocolVersion: status?.protocolVersion ?? peer.negotiatedProtocol,
    capabilities: status?.capabilities ?? peer.negotiatedCapabilities,
    lastSeenAtMs: status?.lastHeartbeatAtMs ?? peer.lastSeenAtMs,
    peerFingerprint: peer.pinnedPublicKeyFingerprint,
  } as const;
}

export function createFleetSettingsRouter(dependencies: FleetSettingsDependencies): express.Router {
  const router = express.Router();
  router.use(requireOwner(dependencies.authMode));
  router.get('/settings', async (_request, response, next) => {
    try {
      const local = await dependencies.identity();
      const statuses = new Map(dependencies.statuses().map((status) => [status.peerId, status]));
      response.json({
        local,
        role: dependencies.role(),
        capacity: { totalInstallations: FLEET_MAX_REMOTE_PEERS + 1, remotePeers: FLEET_MAX_REMOTE_PEERS },
        peers: dependencies.peers().map((peer) => publicPeer(peer, statuses.get(peer.peerId))),
      });
    } catch (error) {
      next(error);
    }
  });
  router.get('/ssh-candidates', async (_request, response, next) => {
    try {
      response.setHeader('Cache-Control', 'no-store');
      response.json(await dependencies.sshCandidates());
    } catch (error) {
      next(error);
    }
  });
  router.post('/peers/:peerId/reconnect', (request, response) => {
    const id = peerId(request);
    if (id === null) {
      response.status(400).json({ error: 'PEER_ID_INVALID' });
      return;
    }
    const accepted = dependencies.reconnect(id);
    response.status(accepted ? 202 : 404).json({ accepted });
  });
  router.delete('/peers/:peerId/local', (request, response) => {
    const id = peerId(request);
    if (id === null) {
      response.status(400).json({ error: 'PEER_ID_INVALID' });
      return;
    }
    const hubLocalRemoval = dependencies.forget(id);
    response.status(hubLocalRemoval === 'not_found' ? 404 : hubLocalRemoval === 'peer_active' ? 409 : 200)
      .json({ hubLocalRemoval });
  });
  return router;
}
