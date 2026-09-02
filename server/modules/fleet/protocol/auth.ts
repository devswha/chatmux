import {
  createHash,
  createPublicKey,
  randomBytes,
  randomUUID,
  verify,
} from 'node:crypto';

import {
  FLEET_PROTOCOL_VERSIONS,
  lengthPrefixedFields,
  type FleetCapability,
  type FleetProtocolVersion,
} from '../../../../shared/fleet.js';

import { FleetProtocolError } from './errors.js';
import {
  FLEET_AUTH_DEADLINE_MS,
  type FleetAuthRole,
  type FleetHelloFrame,
  type FleetProofFrame,
  type FleetTransportMode,
} from './types.js';

export interface FleetIdentitySigner {
  readonly installationId: string;
  sign(challenge: Uint8Array): Promise<Uint8Array>;
}

export type FleetHelloOptions = Readonly<{
  readonly role: FleetAuthRole;
  readonly signer: FleetIdentitySigner;
  readonly processEpoch: string;
  readonly capabilities: readonly FleetCapability[];
  readonly transportMode: FleetTransportMode;
  readonly connectionId?: string;
}>;

export type FleetNegotiation = Readonly<{
  readonly protocolVersion: FleetProtocolVersion;
  readonly capabilities: readonly FleetCapability[];
  readonly challenge: Uint8Array;
  readonly challengeId: string;
}>;

function opposite(role: FleetAuthRole): FleetAuthRole {
  switch (role) {
    case 'hub': return 'peer';
    case 'peer': return 'hub';
  }
}

function fail(message: string): never {
  throw new FleetProtocolError('AUTH_TRANSCRIPT_MISMATCH', message);
}

export function createFleetHello(options: FleetHelloOptions): FleetHelloFrame {
  return {
    kind: 'auth.hello',
    role: options.role,
    installationId: options.signer.installationId,
    processEpoch: options.processEpoch,
    connectionId: options.connectionId ?? randomUUID(),
    nonce: randomBytes(32).toString('base64url'),
    protocolVersions: FLEET_PROTOCOL_VERSIONS,
    capabilities: [...new Set(options.capabilities)],
    transportMode: options.transportMode,
  };
}

export function negotiateFleetChallenge(
  local: FleetHelloFrame,
  remote: FleetHelloFrame,
  expectedRemoteInstallationId: string,
): FleetNegotiation {
  if (remote.role !== opposite(local.role)) fail('remote role is invalid');
  if (remote.installationId !== expectedRemoteInstallationId) fail('remote installation is not pinned');
  if (local.installationId === remote.installationId) fail('installation IDs must differ');
  if (local.connectionId !== remote.connectionId) fail('connection IDs differ');
  if (local.transportMode !== remote.transportMode) fail('transport modes differ');
  const protocolVersion = FLEET_PROTOCOL_VERSIONS.find(
    (candidate) => local.protocolVersions.includes(candidate) && remote.protocolVersions.includes(candidate),
  );
  if (protocolVersion === undefined) fail('protocol versions do not overlap');
  const capabilities = local.capabilities
    .filter((capability) => remote.capabilities.includes(capability))
    .sort((left, right) => left.localeCompare(right));
  const hub = local.role === 'hub' ? local : remote;
  const peer = local.role === 'peer' ? local : remote;
  const challenge = lengthPrefixedFields([
    'chatmux-fleet-mutual-auth-v1',
    hub.installationId,
    peer.installationId,
    hub.processEpoch,
    peer.processEpoch,
    hub.connectionId,
    hub.nonce,
    peer.nonce,
    protocolVersion,
    capabilities.join(','),
    hub.transportMode,
  ]);
  return {
    protocolVersion,
    capabilities,
    challenge,
    challengeId: createHash('sha256').update(challenge).digest('base64url'),
  };
}

export type FleetProofOptions = Readonly<{
  readonly signer: FleetIdentitySigner;
  readonly role: FleetAuthRole;
  readonly connectionId: string;
  readonly challenge: Uint8Array;
}>;

export async function createFleetProof(options: FleetProofOptions): Promise<FleetProofFrame> {
  return {
    kind: 'auth.proof',
    role: options.role,
    installationId: options.signer.installationId,
    connectionId: options.connectionId,
    signature: Buffer.from(await options.signer.sign(options.challenge)).toString('base64url'),
  };
}

export function verifyFleetProof(options: Readonly<{
  readonly proof: FleetProofFrame;
  readonly remoteHello: FleetHelloFrame;
  readonly pinnedPublicKey: string;
  readonly challenge: Uint8Array;
}>): void {
  if (
    options.proof.role !== options.remoteHello.role
    || options.proof.installationId !== options.remoteHello.installationId
    || options.proof.connectionId !== options.remoteHello.connectionId
  ) {
    fail('proof fields do not match hello');
  }
  let valid: boolean;
  try {
    valid = verify(
      null,
      options.challenge,
      createPublicKey(options.pinnedPublicKey),
      Buffer.from(options.proof.signature, 'base64url'),
    );
  } catch (error) {
    if (error instanceof Error) {
      throw new FleetProtocolError('AUTH_SIGNATURE_INVALID', 'peer proof is invalid', { cause: error });
    }
    throw error;
  }
  if (!valid) throw new FleetProtocolError('AUTH_SIGNATURE_INVALID', 'peer proof is invalid');
}

export class FleetAuthDeadline {
  readonly expiresAtMs: number;

  constructor(startedAtMs: number) {
    this.expiresAtMs = startedAtMs + FLEET_AUTH_DEADLINE_MS;
  }

  assertOpen(nowMs: number): void {
    if (nowMs >= this.expiresAtMs) {
      throw new FleetProtocolError('AUTH_DEADLINE_EXCEEDED', 'fleet authentication deadline exceeded');
    }
  }
}

/**
 * Remembers recently accepted challenge ids so an identical proof cannot be
 * accepted twice. The set is a bounded window of the newest ids: an endpoint
 * that reaches capacity forgets the oldest entry rather than refusing every
 * later handshake, which a flaky link or a laptop that sleeps would otherwise
 * trigger after a few thousand reconnects. Replay of an old id past the window
 * is still impossible because both fresh nonces are part of the signed
 * transcript.
 */
export class FleetChallengeReplayGuard {
  private readonly seen = new Set<string>();

  constructor(private readonly capacity = 4_096) {}

  reserve(challengeId: string): boolean {
    if (this.seen.has(challengeId)) return false;
    while (this.seen.size >= this.capacity) {
      const oldest = this.seen.values().next().value;
      if (oldest === undefined) break;
      this.seen.delete(oldest);
    }
    this.seen.add(challengeId);
    return true;
  }
}

export type FleetPinnedInstallation = Readonly<{
  readonly installationId: string;
  readonly pinnedPublicKey: string;
  readonly state: 'active' | 'revoked';
}>;

export interface FleetPeerTrustStore {
  find(installationId: string): Promise<FleetPinnedInstallation | undefined>;
}

export async function requireAuthorizedFleetPeer(
  store: FleetPeerTrustStore,
  installationId: string,
): Promise<FleetPinnedInstallation> {
  const peer = await store.find(installationId);
  if (peer === undefined || peer.state !== 'active') {
    throw new FleetProtocolError('AUTH_PEER_UNAUTHORIZED', 'fleet peer is not authorized');
  }
  return peer;
}
