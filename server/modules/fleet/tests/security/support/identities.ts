import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';

import {
  canonicalPairingIdentity,
  type SignedInstallationIdentity,
} from '@/modules/fleet/services/fleet-pairing.service.js';

import { FLEET_CAPABILITIES, FLEET_PROTOCOL_VERSIONS } from '../../../../../../shared/fleet.js';
import type { FleetIdentitySigner } from '../../../protocol/auth.js';

export type TestInstallation = Readonly<{
  readonly signer: FleetIdentitySigner;
  readonly publicKey: string;
  readonly fingerprint: string;
}>;

export function createInstallation(installationId: string = randomUUID()): TestInstallation {
  const keys = generateKeyPairSync('ed25519');
  const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const der = keys.publicKey.export({ type: 'spki', format: 'der' });
  return {
    signer: {
      installationId,
      sign: async (challenge) => sign(null, challenge, keys.privateKey),
    },
    publicKey,
    fingerprint: `SHA256:${createHash('sha256').update(der).digest('base64url')}`,
  };
}

export async function signedIdentity(
  installation: TestInstallation,
): Promise<SignedInstallationIdentity> {
  const descriptor = {
    installationId: installation.signer.installationId,
    publicKeyFingerprint: installation.fingerprint,
    protocolVersions: FLEET_PROTOCOL_VERSIONS,
    capabilities: FLEET_CAPABILITIES,
  } as const;
  return {
    descriptor,
    publicKey: installation.publicKey,
    signature: Buffer.from(
      await installation.signer.sign(canonicalPairingIdentity(descriptor, installation.publicKey)),
    ).toString('base64url'),
  };
}

// Production-exact verifier tables (server/modules/database/schema-parts/*.ts), minus the
// fleet_peers foreign key: the peer-side trust/generation verifier never reads fleet_peers.
export const PEER_SECURITY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS app_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS fleet_peers (
    peer_id TEXT PRIMARY KEY,
    enrollment_state TEXT NOT NULL CHECK (enrollment_state IN ('enrolled', 'revoked'))
);
CREATE TABLE IF NOT EXISTS fleet_hub_grants (
    grant_id INTEGER PRIMARY KEY AUTOINCREMENT,
    peer_id TEXT NOT NULL,
    hub_installation_id TEXT NOT NULL CHECK (length(hub_installation_id) > 0),
    pinned_public_key TEXT NOT NULL CHECK (length(pinned_public_key) > 0),
    pinned_public_key_fingerprint TEXT NOT NULL
        CHECK (length(pinned_public_key_fingerprint) > 0),
    grant_state TEXT NOT NULL DEFAULT 'active' CHECK (grant_state IN ('active', 'revoked')),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms BETWEEN 0 AND 9007199254740991),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms BETWEEN 0 AND 9007199254740991),
    revoked_at_ms INTEGER CHECK (revoked_at_ms BETWEEN 0 AND 9007199254740991),
    CHECK (
        (grant_state = 'active' AND revoked_at_ms IS NULL)
        OR (grant_state = 'revoked' AND revoked_at_ms IS NOT NULL)
    )
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_fleet_hub_grants_one_active_peer
    ON fleet_hub_grants(peer_id) WHERE grant_state = 'active';
CREATE TABLE IF NOT EXISTS fleet_pairing_tokens (
    token_hash TEXT PRIMARY KEY NOT NULL
        CHECK (length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms BETWEEN 0 AND 9007199254740991),
    expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms BETWEEN 0 AND 9007199254740991),
    consumed_at_ms INTEGER CHECK (consumed_at_ms BETWEEN 0 AND 9007199254740991),
    CHECK (expires_at_ms > created_at_ms),
    CHECK (consumed_at_ms IS NULL OR consumed_at_ms >= created_at_ms)
);
`;

const SECRET_SHAPE = /[A-Za-z0-9_-]{43,}|PRIVATE KEY/;

export function assertNoSecretMaterial(serialized: string, secrets: readonly string[]): void {
  for (const secret of secrets) {
    assert.equal(serialized.includes(secret), false, 'observable output leaks a known secret');
  }
  assert.doesNotMatch(serialized, SECRET_SHAPE, 'observable output carries token, nonce, key, or signature material');
}
