import assert from 'node:assert/strict';
import { createHash, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import test from 'node:test';

import { FleetHubPairingError, FleetHubPairingService } from '@/modules/fleet/services/fleet-hub-pairing.service.js';
import { canonicalPairingIdentity, type SignedInstallationIdentity } from '@/modules/fleet/services/fleet-pairing.service.js';

import { FLEET_CAPABILITIES, FLEET_PROTOCOL_VERSIONS, type FleetInstallationDescriptor } from '../../../../shared/fleet.js';
const NOW = 1_800_000_000_000;
const HUB_ID = '10000000-0000-4000-8000-000000000001';
const PEER_ID = '00000000-0000-4000-8000-000000000001';

function signedIdentity(installationId: string): SignedInstallationIdentity {
  const keys = generateKeyPairSync('ed25519', { privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const der = createPublicKey(keys.publicKey).export({ type: 'spki', format: 'der' });
  const descriptor: FleetInstallationDescriptor = { installationId, publicKeyFingerprint: `SHA256:${createHash('sha256').update(der).digest('base64url')}`, protocolVersions: FLEET_PROTOCOL_VERSIONS, capabilities: FLEET_CAPABILITIES };
  return { descriptor, publicKey: keys.publicKey, signature: sign(null, canonicalPairingIdentity(descriptor, keys.publicKey), keys.privateKey).toString('base64url') };
}

test('redeems through secure transport and pins the returned peer key', async () => {
  // Given: a valid peer response and empty registry.
  const hub = signedIdentity(HUB_ID); const peer = signedIdentity(PEER_ID);
  const calls: unknown[] = []; const enrollments: unknown[] = [];
  const service = new FleetHubPairingService({ identity: hub, now: () => NOW,
    transport: { redeem: async (request) => { calls.push(request); return peer; } },
    peers: { find: () => undefined, list: () => [], enroll: (enrollment) => { enrollments.push(enrollment); return { ok: true, peer: enrollment }; } },
  });
  // When: the hub owner enrolls the peer.
  const result = await service.enroll({ peerUrl: 'wss://peer.example.test/fleet-ws', transportMode: 'direct-wss', token: 'pairing-secret' });
  // Then: the verified key is pinned locally.
  assert.equal(calls.length, 1);
  assert.deepEqual(enrollments, [{ peerId: PEER_ID, url: 'wss://peer.example.test/fleet-ws', transportMode: 'direct-wss', displayLabel: 'peer.example.test', pinnedPublicKey: peer.publicKey, pinnedPublicKeyFingerprint: peer.descriptor.publicKeyFingerprint }]);
  assert.equal(result.peerId, PEER_ID);
});

test('rejects unsafe transport URLs and key substitution', async () => {
  // Given: a response whose public key was substituted after signing.
  const peer = signedIdentity(PEER_ID); const substituted = { ...peer, publicKey: signedIdentity(PEER_ID).publicKey };
  const service = new FleetHubPairingService({ identity: signedIdentity(HUB_ID), now: () => NOW,
    transport: { redeem: async () => substituted }, peers: { find: () => undefined, list: () => [], enroll: () => ({ ok: false, reason: 'capacity' as const }) },
  });
  // When/Then: plaintext non-loopback and altered proofs fail closed.
  await assert.rejects(service.enroll({ peerUrl: 'ws://peer.example.test/fleet-ws', transportMode: 'ssh-loopback', token: 'secret' }), (error) => error instanceof FleetHubPairingError && error.code === 'PEER_URL_INVALID');
  await assert.rejects(service.enroll({ peerUrl: 'wss://peer.example.test/fleet-ws', transportMode: 'direct-wss', token: 'secret' }), (error) => error instanceof FleetHubPairingError && error.code === 'PEER_IDENTITY_INVALID');
});


test('rejects non-canonical enrollment targets before transport or persistence', async () => {
  // Given: a live pairing service with observable transport and persistence boundaries.
  let transportCalls = 0; let persistenceCalls = 0;
  const service = new FleetHubPairingService({ identity: signedIdentity(HUB_ID),
    transport: { redeem: async () => { transportCalls += 1; return signedIdentity(PEER_ID); } },
    peers: { find: () => undefined, list: () => [], enroll: (enrollment) => { persistenceCalls += 1; return { ok: true, peer: enrollment }; } },
  });
  const rejected = [
    ['ws://127.1/fleet-ws', 'ssh-loopback'],
    ['ws://2130706433/fleet-ws', 'ssh-loopback'],
    ['ws://0x7f000001/fleet-ws', 'ssh-loopback'],
    ['ws://127.0.0.1./fleet-ws', 'ssh-loopback'],
    ['ws://[0:0:0:0:0:0:0:1]/fleet-ws', 'ssh-loopback'],
    ['WSS://peer.example.test/fleet-ws', 'direct-wss'],
    ['WsS://peer.example.test/fleet-ws', 'direct-wss'],
    ['wss://peer.example.test/other', 'direct-wss'],
    ['wss://peer.example.test/fleet-ws?token=secret', 'direct-wss'],
    ['wss://peer.example.test/fleet-ws#fragment', 'direct-wss'],
    ['wss://user:secret@peer.example.test/fleet-ws', 'direct-wss'],
    ['ws://192.0.2.1/fleet-ws', 'ssh-loopback'],
    ['ws://127.0.0.1/fleet-ws', 'direct-wss'],
    ['wss://peer.example.test/fleet-ws', 'ssh-loopback'],
  ] as const;

  // When: every hostile URL or mode mismatch is submitted for enrollment.
  const outcomes = await Promise.allSettled(rejected.map(([peerUrl, transportMode]) => service.enroll({ peerUrl, transportMode, token: 'secret' })));

  // Then: canonical policy rejects every input before either side effect boundary.
  assert.ok(outcomes.every((outcome) => outcome.status === 'rejected'
    && outcome.reason instanceof FleetHubPairingError && outcome.reason.code === 'PEER_URL_INVALID'));
  assert.equal(transportCalls, 0); assert.equal(persistenceCalls, 0);
});

test('invokes transport once for each canonical direct and SSH enrollment target', async () => {
  // Given: canonical direct and SSH targets with independently valid peer identities.
  let transportCalls = 0;
  const service = new FleetHubPairingService({ identity: signedIdentity(HUB_ID),
    transport: { redeem: async () => { transportCalls += 1; return signedIdentity(`${transportCalls}0000000-0000-4000-8000-000000000001`); } },
    peers: { find: () => undefined, list: () => [], enroll: (enrollment) => ({ ok: true, peer: enrollment }) },
  });

  // When: canonical targets are enrolled in their matching transport modes.
  await service.enroll({ peerUrl: 'wss://peer.example.test/fleet-ws', transportMode: 'direct-wss', token: 'direct-secret' });
  assert.equal(transportCalls, 1);
  await service.enroll({ peerUrl: 'ws://[::1]:8022/fleet-ws', transportMode: 'ssh-loopback', token: 'ssh-secret' });

  // Then: each enrollment reaches transport exactly once.
  assert.equal(transportCalls, 2);
});


test('never reports success after persistence conflict or interrupted transport', async () => {
  // Given: a valid peer whose local persistence conflicts, plus an interrupted transport.
  const peer = signedIdentity(PEER_ID); let persistenceCalls = 0;
  const conflict = new FleetHubPairingService({ identity: signedIdentity(HUB_ID),
    transport: { redeem: async () => peer },
    peers: { find: () => undefined, list: () => [], enroll: () => { persistenceCalls += 1; return { ok: false, reason: 'duplicate_url' as const }; } },
  });
  const interrupted = new FleetHubPairingService({ identity: signedIdentity(HUB_ID),
    transport: { redeem: async () => { throw new DOMException('interrupted', 'AbortError'); } },
    peers: { find: () => undefined, list: () => [], enroll: () => { persistenceCalls += 1; return { ok: true, peer: { peerId: PEER_ID, url: '', transportMode: 'direct-wss', displayLabel: '', pinnedPublicKey: '', pinnedPublicKeyFingerprint: '' } }; } },
  });
  const input = { peerUrl: 'wss://peer.example.test/fleet-ws', transportMode: 'direct-wss' as const, token: 'secret' };
  // When/Then: neither failure can be mistaken for enrollment.
  await assert.rejects(conflict.enroll(input), (error) => error instanceof FleetHubPairingError && error.code === 'PEER_PERSISTENCE_CONFLICT');
  await assert.rejects(interrupted.enroll(input), (error) => error instanceof DOMException && error.name === 'AbortError');
  assert.equal(persistenceCalls, 1);
});
