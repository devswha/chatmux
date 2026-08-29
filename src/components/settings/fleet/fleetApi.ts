import { FLEET_CAPABILITIES, FLEET_PEER_STATES, FLEET_PROTOCOL_VERSIONS } from '../../../../shared/fleet';
import { authenticatedFetch } from '../../../utils/api';

import type {
  FleetEnrollmentInput,
  FleetPairingCode,
  FleetRevocationResult,
  FleetSettingsPayload,
} from './types';

export class FleetSettingsRequestError extends Error {
  readonly name = 'FleetSettingsRequestError';
  constructor(readonly code: string, readonly status: number) { super(code); }
}

async function body(response: Response): Promise<unknown> {
  const value: unknown = await response.json();
  if (!response.ok) {
    const code = typeof value === 'object' && value !== null && 'error' in value && typeof value.error === 'string'
      ? value.error
      : `HTTP_${response.status}`;
    throw new FleetSettingsRequestError(code, response.status);
  }
  return value;
}

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringIn<const T extends readonly string[]>(value: unknown, values: T): value is T[number] {
  return typeof value === 'string' && values.some((candidate) => candidate === value);
}

function settings(value: unknown): FleetSettingsPayload {
  if (!record(value) || !record(value.local) || !record(value.capacity) || !Array.isArray(value.peers)
    || typeof value.local.installationId !== 'string' || typeof value.local.publicKeyFingerprint !== 'string'
    || !stringIn(value.role, ['standalone', 'hub', 'peer'] as const)
    || typeof value.capacity.totalInstallations !== 'number' || typeof value.capacity.remotePeers !== 'number') {
    throw new FleetSettingsRequestError('MALFORMED_RESPONSE', 502);
  }
  const peers = value.peers;
  if (!peers.every((peer) => record(peer)
    && typeof peer.peerId === 'string' && typeof peer.displayLabel === 'string'
    && stringIn(peer.transportMode, ['direct-wss', 'ssh-loopback'] as const)
    && stringIn(peer.enrollmentState, ['enrolled', 'revoked'] as const)
    && stringIn(peer.state, FLEET_PEER_STATES)
    && (peer.protocolVersion === null || stringIn(peer.protocolVersion, FLEET_PROTOCOL_VERSIONS))
    && Array.isArray(peer.capabilities) && peer.capabilities.every((capability) => stringIn(capability, FLEET_CAPABILITIES))
    && (peer.lastSeenAtMs === null || typeof peer.lastSeenAtMs === 'number')
    && typeof peer.peerFingerprint === 'string')) {
    throw new FleetSettingsRequestError('MALFORMED_RESPONSE', 502);
  }
  return {
    local: { installationId: value.local.installationId, publicKeyFingerprint: value.local.publicKeyFingerprint },
    role: value.role,
    capacity: { totalInstallations: value.capacity.totalInstallations, remotePeers: value.capacity.remotePeers },
    peers,
  };
}

function pairingCode(value: unknown): FleetPairingCode {
  if (!record(value) || typeof value.token !== 'string' || typeof value.expiresAtMs !== 'number') {
    throw new FleetSettingsRequestError('MALFORMED_RESPONSE', 502);
  }
  return { token: value.token, expiresAtMs: value.expiresAtMs };
}

function revocation(value: unknown): FleetRevocationResult {
  if (!record(value)
    || !stringIn(value.localRemoval, ['removed', 'not_found', 'already_removed'] as const)
    || !stringIn(value.peerRevocation, ['revoked', 'refused', 'unreachable', 'not_attempted'] as const)) {
    throw new FleetSettingsRequestError('MALFORMED_RESPONSE', 502);
  }
  return { localRemoval: value.localRemoval, peerRevocation: value.peerRevocation };
}

export const fleetApi = {
  settings: async (signal?: AbortSignal): Promise<FleetSettingsPayload> => settings(await body(
    await authenticatedFetch('/api/fleet/settings', signal === undefined ? {} : { signal }),
  )),
  pairingCode: async (): Promise<FleetPairingCode> => pairingCode(await body(
    await authenticatedFetch('/api/fleet/pairing-tokens', { method: 'POST' }),
  )),
  enroll: async (input: FleetEnrollmentInput): Promise<void> => {
    await body(await authenticatedFetch('/api/fleet/peers', { method: 'POST', body: JSON.stringify(input) }));
  },
  reconnect: async (peerId: string): Promise<void> => {
    await body(await authenticatedFetch(`/api/fleet/peers/${encodeURIComponent(peerId)}/reconnect`, { method: 'POST' }));
  },
  revoke: async (peerId: string): Promise<FleetRevocationResult> => revocation(await body(
    await authenticatedFetch(`/api/fleet/peers/${encodeURIComponent(peerId)}`, { method: 'DELETE' }),
  )),
  removeLocal: async (peerId: string): Promise<void> => {
    await body(await authenticatedFetch(`/api/fleet/peers/${encodeURIComponent(peerId)}/local`, { method: 'DELETE' }));
  },
} as const;
