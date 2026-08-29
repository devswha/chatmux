import fetch from 'node-fetch';

import {
  FleetHubPairingError,
  type FleetPeerRedemptionRequest,
} from '@/modules/fleet/services/fleet-hub-pairing.service.js';
import type { SignedInstallationIdentity } from '@/modules/fleet/services/fleet-pairing.service.js';

const REQUEST_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 64 * 1_024;

type RemotePeer = Readonly<{
  readonly url: string;
  readonly transportMode: 'direct-wss' | 'ssh-loopback';
}>;

function endpoint(peerUrl: string, path: '/api/fleet/pairing/redeem' | '/api/fleet/pairing/revoke'): string {
  const target = new URL(peerUrl);
  switch (target.protocol) {
    case 'wss:': target.protocol = 'https:'; break;
    case 'ws:': target.protocol = 'http:'; break;
    default: throw new FleetHubPairingError('PEER_UNREACHABLE', 'peer transport protocol is unavailable');
  }
  target.pathname = path;
  return target.toString();
}

async function post(url: string, body: unknown): Promise<Readonly<{ status: number; body: unknown }>> {
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof Error) {
      throw new FleetHubPairingError('PEER_UNREACHABLE', 'peer enrollment transport failed');
    }
    throw error;
  }
  const raw = await response.text();
  if (Buffer.byteLength(raw) > MAX_RESPONSE_BYTES) {
    throw new FleetHubPairingError('PEER_UNREACHABLE', 'peer enrollment response exceeded its bound');
  }
  let bodyValue: unknown;
  try {
    bodyValue = JSON.parse(raw);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new FleetHubPairingError('PEER_UNREACHABLE', 'peer enrollment response was malformed');
    }
    throw error;
  }
  return { status: response.status, body: bodyValue };
}

function remoteError(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || !('error' in value)) return null;
  return typeof value.error === 'string' ? value.error : null;
}

export function createFleetPairingTransport() {
  return {
    async redeem(request: FleetPeerRedemptionRequest): Promise<unknown> {
      const result = await post(endpoint(request.peerUrl, '/api/fleet/pairing/redeem'), {
        token: request.token,
        hub: request.hub,
      });
      if (result.status >= 200 && result.status < 300) return result.body;
      switch (remoteError(result.body)) {
        case 'TOKEN_EXPIRED': throw new FleetHubPairingError('PEER_TOKEN_EXPIRED', 'peer pairing token expired');
        case 'TOKEN_ALREADY_USED': throw new FleetHubPairingError('PEER_TOKEN_ALREADY_USED', 'peer pairing token was already used');
        case 'TOKEN_INVALID': case 'TOKEN_NOT_FOUND':
          throw new FleetHubPairingError('PEER_TOKEN_REJECTED', 'peer pairing token was rejected');
        case 'PEER_ROLE_CONFLICT':
          throw new FleetHubPairingError('PEER_ROLE_CONFLICT', 'peer must remove its outbound peers before enrollment');
        default: throw new FleetHubPairingError('PEER_UNREACHABLE', 'peer rejected enrollment');
      }
    },
    async revoke(request: Readonly<{ peer: RemotePeer; hub: SignedInstallationIdentity }>): Promise<boolean> {
      const result = await post(endpoint(request.peer.url, '/api/fleet/pairing/revoke'), request.hub);
      return result.status >= 200 && result.status < 300
        && typeof result.body === 'object' && result.body !== null && 'revoked' in result.body
        && result.body.revoked === true;
    },
  };
}
