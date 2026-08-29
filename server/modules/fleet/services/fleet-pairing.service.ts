import {
  createHash,
  createPublicKey,
  randomBytes as secureRandomBytes,
  verify,
} from 'node:crypto';

import {
  parseFleetInstallationDescriptor,
  type FleetInstallationDescriptor,
} from '../../../../shared/fleet.js';

export const FLEET_PAIRING_TOKEN_BYTES = 32 as const;
export const FLEET_PAIRING_TTL_MS = 10 * 60 * 1_000;

export type SignedInstallationIdentity = Readonly<{
  descriptor: FleetInstallationDescriptor;
  publicKey: string;
  signature: string;
}>;
export type HubGrantPin = Readonly<{
  peerId: string;
  hubInstallationId: string;
  pinnedPublicKey: string;
  pinnedPublicKeyFingerprint: string;
  revokedAtMs: number | null;
}>;
export type PairingStoreResult = Readonly<{
  kind: 'enrolled' | 'not_found' | 'expired' | 'already_consumed' | 'active_grant_exists' | 'role_conflict';
}>;
export interface AtomicPairingStore {
  issue(token: Uint8Array, expiresAtMs: number, nowMs: number): void;
  consumeAndPin(token: Uint8Array, grant: HubGrantPin, nowMs: number): PairingStoreResult;
  revoke(peerId: string, nowMs: number): boolean;
  revokeAuthorized?(
    peerId: string,
    hubInstallationId: string,
    pinnedPublicKey: string,
    nowMs: number,
  ): boolean;
}
type PairingDependencies = Readonly<{
  store: AtomicPairingStore;
  identity: SignedInstallationIdentity;
  now?: () => number;
  randomBytes?: () => Uint8Array;
}>;
export type PairingErrorCode =
  | 'TOKEN_INVALID'
  | 'TOKEN_NOT_FOUND'
  | 'TOKEN_EXPIRED'
  | 'TOKEN_ALREADY_USED'
  | 'ACTIVE_GRANT_EXISTS'
  | 'PEER_ROLE_CONFLICT'
  | 'IDENTITY_PROOF_INVALID';

export class FleetPairingError extends Error {
  readonly name = 'FleetPairingError';
  constructor(readonly code: PairingErrorCode, message: string) { super(message); }
}

export function canonicalPairingIdentity(
  descriptor: FleetInstallationDescriptor,
  publicKey: string,
): Buffer {
  const fields = [
    'chatmux-fleet-pairing-identity-v1',
    descriptor.installationId,
    descriptor.publicKeyFingerprint,
    descriptor.protocolVersions.join(','),
    descriptor.capabilities.join(','),
    publicKey,
  ];
  const chunks = fields.map((field) => {
    const value = Buffer.from(field, 'utf8');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(value.byteLength);
    return Buffer.concat([length, value]);
  });
  return Buffer.concat(chunks);
}

function fingerprint(publicKey: string): string | null {
  try {
    const key = createPublicKey(publicKey);
    if (key.asymmetricKeyType !== 'ed25519') return null;
    const der = key.export({ type: 'spki', format: 'der' });
    return `SHA256:${createHash('sha256').update(der).digest('base64url')}`;
  } catch (error) {
    if (error instanceof Error) return null;
    throw error;
  }
}

export function verifySignedInstallationIdentity(value: SignedInstallationIdentity): boolean {
  let descriptor: FleetInstallationDescriptor;
  try {
    descriptor = parseFleetInstallationDescriptor(value.descriptor);
  } catch (error) {
    if (error instanceof Error) return false;
    throw error;
  }
  if (fingerprint(value.publicKey) !== descriptor.publicKeyFingerprint) return false;
  const signature = Buffer.from(value.signature, 'base64url');
  if (signature.byteLength !== 64 || signature.toString('base64url') !== value.signature) return false;
  try {
    return verify(null, canonicalPairingIdentity(descriptor, value.publicKey), value.publicKey, signature);
  } catch (error) {
    if (error instanceof Error) return false;
    throw error;
  }
}

function parsePairingToken(token: string): Buffer {
  const decoded = Buffer.from(token, 'base64url');
  if (decoded.byteLength !== FLEET_PAIRING_TOKEN_BYTES || decoded.toString('base64url') !== token) {
    throw new FleetPairingError('TOKEN_INVALID', 'pairing token is invalid');
  }
  return decoded;
}

function pairingFailure(result: Exclude<PairingStoreResult['kind'], 'enrolled'>): FleetPairingError {
  switch (result) {
    case 'not_found': return new FleetPairingError('TOKEN_NOT_FOUND', 'pairing token was not found');
    case 'expired': return new FleetPairingError('TOKEN_EXPIRED', 'pairing token expired');
    case 'already_consumed': return new FleetPairingError('TOKEN_ALREADY_USED', 'pairing token was already used');
    case 'active_grant_exists': return new FleetPairingError('ACTIVE_GRANT_EXISTS', 'revoke the active hub before pairing a replacement');
    case 'role_conflict': return new FleetPairingError('PEER_ROLE_CONFLICT', 'remove all outbound peers before enrolling this installation as a peer');
  }
}

export class FleetPairingService {
  constructor(private readonly dependencies: PairingDependencies) {}

  issueToken(): Readonly<{ token: string; expiresAtMs: number }> {
    const nowMs = this.dependencies.now?.() ?? Date.now();
    const token = this.dependencies.randomBytes?.() ?? secureRandomBytes(FLEET_PAIRING_TOKEN_BYTES);
    if (token.byteLength !== FLEET_PAIRING_TOKEN_BYTES) {
      throw new FleetPairingError('TOKEN_INVALID', 'pairing entropy source returned an invalid token');
    }
    const expiresAtMs = nowMs + FLEET_PAIRING_TTL_MS;
    this.dependencies.store.issue(token, expiresAtMs, nowMs);
    return { token: Buffer.from(token).toString('base64url'), expiresAtMs };
  }

  redeem(input: Readonly<{ token: string; hub: SignedInstallationIdentity }>): SignedInstallationIdentity {
    if (!verifySignedInstallationIdentity(input.hub)) {
      throw new FleetPairingError('IDENTITY_PROOF_INVALID', 'hub installation identity proof is invalid');
    }
    const result = this.dependencies.store.consumeAndPin(parsePairingToken(input.token), {
      peerId: this.dependencies.identity.descriptor.installationId,
      hubInstallationId: input.hub.descriptor.installationId,
      pinnedPublicKey: input.hub.publicKey,
      pinnedPublicKeyFingerprint: input.hub.descriptor.publicKeyFingerprint,
      revokedAtMs: null,
    }, this.dependencies.now?.() ?? Date.now());
    if (result.kind !== 'enrolled') throw pairingFailure(result.kind);
    return this.dependencies.identity;
  }

  revokeHubGrant(hub?: SignedInstallationIdentity): boolean {
    const nowMs = this.dependencies.now?.() ?? Date.now();
    if (hub === undefined) {
      return this.dependencies.store.revoke(this.dependencies.identity.descriptor.installationId, nowMs);
    }
    if (!verifySignedInstallationIdentity(hub)) return false;
    return this.dependencies.store.revokeAuthorized?.(
      this.dependencies.identity.descriptor.installationId,
      hub.descriptor.installationId,
      hub.publicKey,
      nowMs,
    ) ?? false;
  }
}
