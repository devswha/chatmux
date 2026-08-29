import assert from 'node:assert/strict';
import test from 'node:test';

import { FleetRevocationService } from '@/modules/fleet/services/fleet-revocation.service.js';

const NOW = 1_800_000_000_000;
const PEER_ID = '00000000-0000-4000-8000-000000000001';
const peer = { peerId: PEER_ID, url: 'wss://peer.example.test/fleet-ws', transportMode: 'direct-wss' as const, enrollmentState: 'enrolled' as const };
const revokedPeer = { ...peer, enrollmentState: 'revoked' as const };
const identity = { descriptor: { installationId: '10000000-0000-4000-8000-000000000001', publicKeyFingerprint: 'fingerprint', protocolVersions: ['fleet/1'] as const, capabilities: [] }, publicKey: 'public-key', signature: 'signature' };

function controlledPromise<T>(): Readonly<{
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}> {
  let resolvePromise: (value: T) => void = () => undefined;
  let rejectPromise: (error: Error) => void = () => undefined;
  const promise = new Promise<T>((resolve, reject) => { resolvePromise = resolve; rejectPromise = reject; });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

test('revokes local authorization before awaiting remote transport', async () => {
  // Given: an enrolled peer and an externally held remote revoke.
  const localState: { peer: typeof peer | typeof revokedPeer } = { peer };
  const started = controlledPromise<void>(); const release = controlledPromise<boolean>();
  const service = new FleetRevocationService({ now: () => NOW, identity,
    peers: { find: () => localState.peer, revoke: () => { localState.peer = revokedPeer; return localState.peer; } },
    transport: { revoke: async () => { started.resolve(); return release.promise; } },
  });
  // When: removal reaches the held remote transport.
  const removal = service.remove(PEER_ID); await started.promise;
  // Then: local admission is already denied before remote completion.
  try {
    assert.equal(localState.peer.enrollmentState, 'revoked');
  } finally {
    release.resolve(true);
    await removal;
  }
  assert.deepEqual(await removal, { localRemoval: 'removed', peerRevocation: 'revoked' });
});

test('remote rejection leaves local authorization revoked', async () => {
  // Given: an enrolled peer and an externally rejected remote revoke.
  const localState: { peer: typeof peer | typeof revokedPeer } = { peer };
  const started = controlledPromise<void>(); const release = controlledPromise<boolean>();
  const service = new FleetRevocationService({ now: () => NOW, identity,
    peers: { find: () => localState.peer, revoke: () => { localState.peer = revokedPeer; return localState.peer; } },
    transport: { revoke: async () => { started.resolve(); return release.promise; } },
  });
  // When: local removal completes and the remote operation rejects like a timeout.
  const removal = service.remove(PEER_ID); await started.promise;
  try {
    assert.equal(localState.peer.enrollmentState, 'revoked');
  } finally {
    release.reject(new DOMException('timed out', 'TimeoutError'));
  }
  const result = await removal;
  // Then: remote failure is explicit while local authorization remains denied.
  assert.equal(localState.peer.enrollmentState, 'revoked');
  assert.deepEqual(result, { localRemoval: 'removed', peerRevocation: 'unreachable' });
});

test('reports peer-side revoke separately and avoids success for unknown peers', async () => {
  // Given: one reachable peer and one absent record.
  const reachable = new FleetRevocationService({ now: () => NOW, identity, peers: { find: () => peer, revoke: () => revokedPeer }, transport: { revoke: async () => true } });
  const missing = new FleetRevocationService({ now: () => NOW, identity, peers: { find: () => undefined, revoke: () => undefined }, transport: { revoke: async () => true } });
  // When: both removals are requested.
  const [removed, absent] = await Promise.all([reachable.remove(PEER_ID), missing.remove(PEER_ID)]);
  // Then: remote and local outcomes cannot be conflated.
  assert.deepEqual(removed, { localRemoval: 'removed', peerRevocation: 'revoked' });
  assert.deepEqual(absent, { localRemoval: 'not_found', peerRevocation: 'not_attempted' });
});
