import assert from 'node:assert/strict';
import { createHash, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import test from 'node:test';

import { FleetPairingError, FleetPairingService, canonicalPairingIdentity, type AtomicPairingStore, type HubGrantPin, type SignedInstallationIdentity } from '@/modules/fleet/services/fleet-pairing.service.js';

import { FLEET_CAPABILITIES, FLEET_PROTOCOL_VERSIONS, type FleetInstallationDescriptor } from '../../../../shared/fleet.js';

const NOW = 1_800_000_000_000;
const PEER_ID = '00000000-0000-4000-8000-000000000001';
const HUB_ID = '10000000-0000-4000-8000-000000000001';

function signedIdentity(installationId: string): SignedInstallationIdentity {
  const keys = generateKeyPairSync('ed25519', { privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const der = createPublicKey(keys.publicKey).export({ type: 'spki', format: 'der' });
  const descriptor: FleetInstallationDescriptor = { installationId, publicKeyFingerprint: `SHA256:${createHash('sha256').update(der).digest('base64url')}`, protocolVersions: FLEET_PROTOCOL_VERSIONS, capabilities: FLEET_CAPABILITIES };
  return { descriptor, publicKey: keys.publicKey, signature: sign(null, canonicalPairingIdentity(descriptor, keys.publicKey), keys.privateKey).toString('base64url') };
}

class MemoryPairingStore implements AtomicPairingStore {
  readonly tokenHashes: string[] = [];
  readonly grants: HubGrantPin[] = [];
  private readonly tokens = new Map<string, { readonly expiresAtMs: number; consumed: boolean }>();
  issue(token: Uint8Array, expiresAtMs: number): void { const hash = createHash('sha256').update(token).digest('hex'); this.tokenHashes.push(hash); this.tokens.set(hash, { expiresAtMs, consumed: false }); }
  consumeAndPin(token: Uint8Array, grant: HubGrantPin, nowMs: number) {
    const stored = this.tokens.get(createHash('sha256').update(token).digest('hex'));
    if (!stored) return { kind: 'not_found' } as const;
    if (stored.consumed) return { kind: 'already_consumed' } as const;
    if (stored.expiresAtMs <= nowMs) return { kind: 'expired' } as const;
    if (this.grants.some((item) => item.peerId === grant.peerId && item.revokedAtMs === null)) return { kind: 'active_grant_exists' } as const;
    stored.consumed = true; this.grants.push(grant); return { kind: 'enrolled' } as const;
  }
  revoke(peerId: string, nowMs: number): boolean { const index = this.grants.findIndex((grant) => grant.peerId === peerId && grant.revokedAtMs === null); if (index < 0) return false; const grant = this.grants[index]; if (!grant) return false; this.grants[index] = { ...grant, revokedAtMs: nowMs }; return true; }
}

test('issues 32 bytes for ten minutes and persists only the hash', () => {
  // Given: deterministic cryptographic entropy.
  const store = new MemoryPairingStore(); const entropy = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
  const service = new FleetPairingService({ store, identity: signedIdentity(PEER_ID), now: () => NOW, randomBytes: () => entropy });
  // When: the owner creates a token.
  const issued = service.issueToken();
  // Then: entropy, TTL, and hash-only storage satisfy the pairing contract.
  assert.equal(Buffer.from(issued.token, 'base64url').byteLength, 32); assert.equal(issued.expiresAtMs, NOW + 600_000);
  assert.deepEqual(store.tokenHashes, [createHash('sha256').update(entropy).digest('hex')]); assert.equal(JSON.stringify(store).includes(issued.token), false);
});

test('consumes one token once and pins the signed hub identity', async () => {
  // Given: one valid token and signed hub identity.
  const store = new MemoryPairingStore(); const service = new FleetPairingService({ store, identity: signedIdentity(PEER_ID), now: () => NOW });
  const issued = service.issueToken(); const hub = signedIdentity(HUB_ID);
  // When: two redemptions race.
  const results = await Promise.allSettled([Promise.resolve().then(() => service.redeem({ token: issued.token, hub })), Promise.resolve().then(() => service.redeem({ token: issued.token, hub }))]);
  // Then: exactly one succeeds and pins the key.
  assert.deepEqual(results.map((result) => result.status).sort(), ['fulfilled', 'rejected']); assert.equal(store.grants[0]?.pinnedPublicKey, hub.publicKey);
  assert.equal(results.some((result) => result.status === 'rejected' && result.reason instanceof FleetPairingError && result.reason.code === 'TOKEN_ALREADY_USED'), true);
});

test('rejects expiry, key substitution, and replacement until revoke', () => {
  // Given: a service with controllable time.
  let now = NOW; const store = new MemoryPairingStore(); const service = new FleetPairingService({ store, identity: signedIdentity(PEER_ID), now: () => now });
  const stale = service.issueToken(); const hub = signedIdentity(HUB_ID); now += 600_000;
  // When/Then: stale and altered proofs fail, and active grants cannot be replaced.
  assert.throws(() => service.redeem({ token: stale.token, hub }), (error) => error instanceof FleetPairingError && error.code === 'TOKEN_EXPIRED'); now += 1;
  const altered = { ...hub, publicKey: signedIdentity(HUB_ID).publicKey }; const alteredToken = service.issueToken();
  assert.throws(() => service.redeem({ token: alteredToken.token, hub: altered }), (error) => error instanceof FleetPairingError && error.code === 'IDENTITY_PROOF_INVALID');
  service.redeem({ token: service.issueToken().token, hub });
  assert.throws(() => service.redeem({ token: service.issueToken().token, hub }), (error) => error instanceof FleetPairingError && error.code === 'ACTIVE_GRANT_EXISTS');
  assert.equal(service.revokeHubGrant(), true); assert.equal(service.redeem({ token: service.issueToken().token, hub }).descriptor.installationId, PEER_ID);
});
