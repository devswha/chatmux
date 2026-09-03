import { parseFleetTransportTarget } from '@/modules/fleet/protocol/transport-policy.js';
import type { FleetTransportMode } from '@/modules/fleet/protocol/types.js';
import {
  verifySignedInstallationIdentity,
  type SignedInstallationIdentity,
} from '@/modules/fleet/services/fleet-pairing.service.js';

import { parseFleetInstallationDescriptor } from '../../../../shared/fleet.js';

export type FleetPairingTransportMode = FleetTransportMode;

type Enrollment = Readonly<{
  peerId: string;
  url: string;
  transportMode: FleetPairingTransportMode;
  displayLabel: string;
  pinnedPublicKey: string;
  pinnedPublicKeyFingerprint: string;
}>;
type EnrollmentFailure =
  | 'capacity'
  | 'role_conflict'
  | 'duplicate_peer_id'
  | 'duplicate_url'
  | 'duplicate_public_key'
  | 'duplicate_fingerprint';
type StoredPeer = Readonly<{ peerId: string; enrollmentState?: 'enrolled' | 'revoked' }>;
interface FleetPeerRegistry {
  find(peerId: string): StoredPeer | undefined;
  list(): readonly StoredPeer[];
  enroll(input: Enrollment, nowMs: number):
    | Readonly<{ ok: true; peer: Enrollment }>
    | Readonly<{ ok: false; reason: EnrollmentFailure }>;
}
export type FleetPeerRedemptionRequest = Readonly<{
  peerUrl: string;
  transportMode: FleetPairingTransportMode;
  token: string;
  hub: SignedInstallationIdentity;
}>;
interface FleetPairingTransport {
  redeem(request: FleetPeerRedemptionRequest): Promise<unknown>;
}
type HubPairingDependencies = Readonly<{
  identity: SignedInstallationIdentity;
  peers: FleetPeerRegistry;
  transport: FleetPairingTransport;
  activeInboundGrant?: () => boolean;
  now?: () => number;
}>;
export type FleetHubPairingErrorCode =
  | 'PEER_URL_INVALID'
  | 'PEER_ALREADY_ENROLLED'
  | 'PEER_CAPACITY_REACHED'
  | 'PEER_IDENTITY_INVALID'
  | 'PEER_PERSISTENCE_CONFLICT'
  | 'HUB_ROLE_CONFLICT'
  | 'PEER_ROLE_CONFLICT'
  | 'PEER_TOKEN_EXPIRED'
  | 'PEER_TOKEN_ALREADY_USED'
  | 'PEER_TOKEN_REJECTED'
  | 'PEER_UNREACHABLE';

export class FleetHubPairingError extends Error {
  readonly name = 'FleetHubPairingError';
  constructor(readonly code: FleetHubPairingErrorCode, message: string) { super(message); }
}

function parseSignedIdentity(value: unknown): SignedInstallationIdentity {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || !('descriptor' in value) || !('publicKey' in value) || !('signature' in value)
    || Object.keys(value).length !== 3
    || typeof value.publicKey !== 'string' || typeof value.signature !== 'string') {
    throw new FleetHubPairingError('PEER_IDENTITY_INVALID', 'peer installation identity is invalid');
  }
  try {
    return {
      descriptor: parseFleetInstallationDescriptor(value.descriptor),
      publicKey: value.publicKey,
      signature: value.signature,
    };
  } catch (error) {
    if (error instanceof Error) {
      throw new FleetHubPairingError('PEER_IDENTITY_INVALID', 'peer installation identity is invalid');
    }
    throw error;
  }
}

export class FleetHubPairingService {
  constructor(private readonly dependencies: HubPairingDependencies) {}

  preflight(input: Readonly<{ peerUrl: string; transportMode: FleetPairingTransportMode }>): void {
    if (this.dependencies.activeInboundGrant?.() === true) {
      throw new FleetHubPairingError('HUB_ROLE_CONFLICT', 'revoke the inbound hub grant before enrolling outbound peers');
    }
    const target = parseFleetTransportTarget(input.peerUrl, input.transportMode);
    if (!target.ok) {
      throw new FleetHubPairingError('PEER_URL_INVALID', 'peer URL does not match its transport mode');
    }
    if (this.dependencies.peers.list().filter((peer) => peer.enrollmentState !== 'revoked').length >= 9) {
      throw new FleetHubPairingError('PEER_CAPACITY_REACHED', 'fleet peer capacity reached');
    }
  }

  async enroll(input: Readonly<{
    peerUrl: string;
    transportMode: FleetPairingTransportMode;
    token: string;
    label?: string;
  }>): Promise<Enrollment> {
    this.preflight(input);
    const target = parseFleetTransportTarget(input.peerUrl, input.transportMode);
    if (!target.ok) throw new FleetHubPairingError('PEER_URL_INVALID', 'peer URL does not match its transport mode');
    const remote = parseSignedIdentity(await this.dependencies.transport.redeem({
      ...input,
      hub: this.dependencies.identity,
    }));
    if (!verifySignedInstallationIdentity(remote)) {
      throw new FleetHubPairingError('PEER_IDENTITY_INVALID', 'peer installation identity proof is invalid');
    }
    const existing = this.dependencies.peers.find(remote.descriptor.installationId);
    if (existing?.enrollmentState !== 'revoked' && existing !== undefined) {
      throw new FleetHubPairingError('PEER_ALREADY_ENROLLED', 'revoke the peer before replacing enrollment');
    }
    const enrollment: Enrollment = {
      peerId: remote.descriptor.installationId,
      url: input.peerUrl,
      transportMode: input.transportMode,
      displayLabel: input.label ?? target.target.hostname,
      pinnedPublicKey: remote.publicKey,
      pinnedPublicKeyFingerprint: remote.descriptor.publicKeyFingerprint,
    };
    const stored = this.dependencies.peers.enroll(enrollment, this.dependencies.now?.() ?? Date.now());
    if (!stored.ok) {
      if (stored.reason === 'capacity') {
        throw new FleetHubPairingError('PEER_CAPACITY_REACHED', 'fleet peer capacity reached');
      }
      if (stored.reason === 'role_conflict') {
        throw new FleetHubPairingError('HUB_ROLE_CONFLICT', 'revoke the inbound hub grant before enrolling outbound peers');
      }
      throw new FleetHubPairingError('PEER_PERSISTENCE_CONFLICT', 'peer enrollment conflicts with existing metadata');
    }
    return stored.peer;
  }
}
