import express from 'express';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

import { authorizeFleetOwner } from '@/modules/fleet/services/fleet-owner-authorization.service.js';
import { FleetHubPairingError, type FleetPairingTransportMode } from '@/modules/fleet/services/fleet-hub-pairing.service.js';
import type { FleetPairingFailureLimiter } from '@/modules/fleet/services/fleet-pairing-limiter.service.js';
import { FleetPairingError, type SignedInstallationIdentity } from '@/modules/fleet/services/fleet-pairing.service.js';
import type { FleetRemovalResult } from '@/modules/fleet/services/fleet-revocation.service.js';
import { limiterClientAddress } from '@/middleware/client-address.js';

import { parseFleetInstallationDescriptor } from '../../../shared/fleet.js';

type AuthMode = 'none' | 'password' | 'tailscale';
type OwnerPrincipal = Readonly<{ id?: number; tailscaleRole?: string }>;
type PeerEnrollmentInput = Readonly<{
  peerUrl: string;
  transportMode: FleetPairingTransportMode;
  token: string;
  label?: string;
}>;
type PairingRoutesDependencies = Readonly<{
  authMode: AuthMode;
  limiter: FleetPairingFailureLimiter;
  pairing: Readonly<{
    issueToken(): Readonly<{ token: string; expiresAtMs: number }> | Promise<Readonly<{ token: string; expiresAtMs: number }>>;
    redeem(input: Readonly<{ token: string; hub: SignedInstallationIdentity }>): SignedInstallationIdentity | Promise<SignedInstallationIdentity>;
    revokeHubGrant(hub?: SignedInstallationIdentity): boolean | Promise<boolean>;
  }>;
  hubPairing: Readonly<{ enroll(input: PeerEnrollmentInput): Promise<Readonly<{ peerId: string }>> }>;
  revocation: Readonly<{ remove(peerId: string): Promise<FleetRemovalResult> }>;
}>;

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

class FleetPairingRequestError extends Error {
  readonly name = 'FleetPairingRequestError';
  constructor(readonly code: 'BODY_INVALID' | 'MACHINE_CREDENTIAL_INVALID') { super(code); }
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new FleetPairingRequestError('BODY_INVALID');
  }
  const parsed: Record<string, unknown> = {};
  for (const key of Object.keys(value)) parsed[key] = Reflect.get(value, key);
  return parsed;
}

function exact(value: Readonly<Record<string, unknown>>, keys: readonly string[]): void {
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) {
    throw new FleetPairingRequestError('BODY_INVALID');
  }
}

function pairingToken(value: unknown): string {
  if (typeof value !== 'string' || !TOKEN.test(value)) {
    throw new FleetPairingRequestError('BODY_INVALID');
  }
  return value;
}

function signedIdentity(value: unknown): SignedInstallationIdentity {
  const input = record(value);
  exact(input, ['descriptor', 'publicKey', 'signature']);
  if (typeof input.publicKey !== 'string' || typeof input.signature !== 'string') {
    throw new FleetPairingRequestError('BODY_INVALID');
  }
  try {
    return {
      descriptor: parseFleetInstallationDescriptor(input.descriptor),
      publicKey: input.publicKey,
      signature: input.signature,
    };
  } catch (error) {
    if (error instanceof Error) throw new FleetPairingRequestError('BODY_INVALID');
    throw error;
  }
}

function redemptionBody(value: unknown): Readonly<{ token: string; hub: SignedInstallationIdentity }> {
  const input = record(value);
  exact(input, ['token', 'hub']);
  return { token: pairingToken(input.token), hub: signedIdentity(input.hub) };
}

function enrollmentBody(value: unknown): PeerEnrollmentInput {
  const input = record(value);
  const keys = Object.keys(input);
  if (keys.length !== 3 && keys.length !== 4) throw new FleetPairingRequestError('BODY_INVALID');
  if (!keys.every((key) => ['peerUrl', 'transportMode', 'token', 'label'].includes(key))) {
    throw new FleetPairingRequestError('BODY_INVALID');
  }
  if (typeof input.peerUrl !== 'string' || input.peerUrl.length === 0 || input.peerUrl.length > 2_048
    || (input.transportMode !== 'direct-wss' && input.transportMode !== 'ssh-loopback')
    || (input.label !== undefined && (typeof input.label !== 'string' || input.label.trim().length === 0 || input.label.length > 80))) {
    throw new FleetPairingRequestError('BODY_INVALID');
  }
  return {
    peerUrl: input.peerUrl,
    transportMode: input.transportMode,
    token: pairingToken(input.token),
    ...(input.label === undefined ? {} : { label: input.label.trim() }),
  };
}

function requestPrincipal(request: Request): OwnerPrincipal | undefined {
  if (!('user' in request)) return undefined;
  const value = request.user;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const id = 'id' in value && typeof value.id === 'number' ? value.id : undefined;
  const tailscaleRole = 'tailscaleRole' in value && typeof value.tailscaleRole === 'string'
    ? value.tailscaleRole
    : undefined;
  if (id !== undefined && tailscaleRole !== undefined) return { id, tailscaleRole };
  if (id !== undefined) return { id };
  return tailscaleRole === undefined ? undefined : { tailscaleRole };
}

function requireOwner(authMode: AuthMode): RequestHandler {
  return (request, response, next) => {
    const decision = authorizeFleetOwner({
      authMode,
      principal: requestPrincipal(request),
      remoteAddress: request.socket.remoteAddress,
    });
    if (!decision.authorized) return response.status(403).json({ error: decision.reason });
    next();
  };
}

function pairingErrorStatus(code: FleetPairingError['code']): number {
  switch (code) {
    case 'TOKEN_INVALID': return 400;
    case 'TOKEN_NOT_FOUND': return 401;
    case 'TOKEN_EXPIRED': case 'TOKEN_ALREADY_USED': return 410;
    case 'ACTIVE_GRANT_EXISTS': case 'PEER_ROLE_CONFLICT': return 409;
    case 'IDENTITY_PROOF_INVALID': return 422;
  }
}

function hubErrorStatus(code: FleetHubPairingError['code']): number {
  switch (code) {
    case 'PEER_URL_INVALID': return 400;
    case 'PEER_ALREADY_ENROLLED': case 'PEER_PERSISTENCE_CONFLICT': return 409;
    case 'PEER_CAPACITY_REACHED': case 'HUB_ROLE_CONFLICT': case 'PEER_ROLE_CONFLICT': return 409;
    case 'PEER_IDENTITY_INVALID': return 422;
    case 'PEER_TOKEN_EXPIRED': case 'PEER_TOKEN_ALREADY_USED': return 410;
    case 'PEER_TOKEN_REJECTED': return 401;
    case 'PEER_UNREACHABLE': return 502;
  }
}

function machineRequest(request: Request): void {
  if (Object.keys(request.query).length > 0 || request.headers.cookie !== undefined
    || request.headers.authorization !== undefined || request.headers.origin !== undefined) {
    throw new FleetPairingRequestError('MACHINE_CREDENTIAL_INVALID');
  }
}

function sendBoundaryError(error: unknown, response: Response, next: NextFunction): void {
  if (error instanceof FleetPairingRequestError) {
    response.status(400).json({ error: error.code }); return;
  }
  if (error instanceof FleetHubPairingError) {
    response.status(hubErrorStatus(error.code)).json({ error: error.code }); return;
  }
  next(error);
}

export function createFleetPairingRouter(dependencies: PairingRoutesDependencies): express.Router {
  const router = express.Router();
  const owner = requireOwner(dependencies.authMode);
  router.post('/pairing-tokens', owner, async (_request, response, next) => {
    try {
      response.status(201).json(await dependencies.pairing.issueToken());
    } catch (error) {
      next(error);
    }
  });
  router.post('/pairing/redeem', async (request, response, next) => {
    // X-Forwarded-For counts only when a loopback proxy recorded it; a direct
    // client is counted by its socket address (see routes/login-limiter.js).
    const limiterKey = limiterClientAddress(request);
    const admission = dependencies.limiter.admit(limiterKey);
    if (!admission.allowed) {
      response.set('Retry-After', String(admission.retryAfterSeconds));
      response.status(429).json({ error: 'PAIRING_RATE_LIMITED' }); return;
    }
    try {
      machineRequest(request);
      const result = await dependencies.pairing.redeem(redemptionBody(request.body));
      dependencies.limiter.clear(limiterKey);
      response.json(result);
    } catch (error) {
      if (error instanceof FleetPairingError) {
        dependencies.limiter.recordFailure(limiterKey);
        response.status(pairingErrorStatus(error.code)).json({ error: error.code }); return;
      }
      sendBoundaryError(error, response, next);
    }
  });
  router.delete('/hub-grant', owner, async (_request, response, next) => {
    try {
      response.json({ revoked: await dependencies.pairing.revokeHubGrant() });
    } catch (error) {
      next(error);
    }
  });
  router.post('/pairing/revoke', async (request, response, next) => {
    try {
      machineRequest(request);
      response.json({ revoked: await dependencies.pairing.revokeHubGrant(signedIdentity(request.body)) });
    } catch (error) {
      sendBoundaryError(error, response, next);
    }
  });
  router.post('/peers', owner, async (request, response, next) => {
    try {
      response.status(201).json(await dependencies.hubPairing.enroll(enrollmentBody(request.body)));
    } catch (error) {
      sendBoundaryError(error, response, next);
    }
  });
  router.delete('/peers/:peerId', owner, async (request, response, next) => {
    try {
      const peerId = request.params.peerId;
      if (peerId === undefined || !UUID_V4.test(peerId)) throw new FleetPairingRequestError('BODY_INVALID');
      response.json(await dependencies.revocation.remove(peerId));
    } catch (error) {
      sendBoundaryError(error, response, next);
    }
  });
  return router;
}
