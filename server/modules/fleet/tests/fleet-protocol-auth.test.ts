import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign, type KeyObject } from 'node:crypto';
import test from 'node:test';

import {
  createFleetHello,
  createFleetProof,
  FleetAuthDeadline,
  negotiateFleetChallenge,
  verifyFleetProof,
  type FleetIdentitySigner,
} from '../protocol/auth.js';
import { FLEET_AUTH_DEADLINE_MS } from '../protocol/types.js';

const CAPABILITIES = ['catalog.read', 'chat.control', 'session.read'] as const;

type IdentityFixture = Readonly<{
  readonly signer: FleetIdentitySigner;
  readonly publicKey: string;
  readonly privateKey: KeyObject;
}>;

function identity(): IdentityFixture {
  const installationId = randomUUID();
  const keys = generateKeyPairSync('ed25519');
  return {
    signer: {
      installationId,
      sign: async (challenge) => sign(null, challenge, keys.privateKey),
    },
    publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKey: keys.privateKey,
  };
}

function hellos() {
  const hub = identity();
  const peer = identity();
  const connectionId = randomUUID();
  return {
    hub,
    peer,
    hubHello: createFleetHello({
      role: 'hub', signer: hub.signer, processEpoch: 'hub-epoch', capabilities: CAPABILITIES,
      transportMode: 'direct-wss', connectionId,
    }),
    peerHello: createFleetHello({
      role: 'peer', signer: peer.signer, processEpoch: 'peer-epoch', capabilities: ['session.read', 'catalog.read'],
      transportMode: 'direct-wss', connectionId,
    }),
  };
}

test('Given pinned installations, when both sign the canonical challenge, then mutual authentication succeeds', async () => {
  const fixture = hellos();
  const fromHub = negotiateFleetChallenge(fixture.hubHello, fixture.peerHello, fixture.peer.signer.installationId);
  const fromPeer = negotiateFleetChallenge(fixture.peerHello, fixture.hubHello, fixture.hub.signer.installationId);
  const [hubProof, peerProof] = await Promise.all([
    createFleetProof({ signer: fixture.hub.signer, role: 'hub', connectionId: fixture.hubHello.connectionId, challenge: fromHub.challenge }),
    createFleetProof({ signer: fixture.peer.signer, role: 'peer', connectionId: fixture.peerHello.connectionId, challenge: fromPeer.challenge }),
  ]);

  assert.deepEqual(fromHub.challenge, fromPeer.challenge);
  assert.deepEqual(fromHub.capabilities, ['catalog.read', 'session.read']);
  verifyFleetProof({ proof: hubProof, remoteHello: fixture.hubHello, pinnedPublicKey: fixture.hub.publicKey, challenge: fromPeer.challenge });
  verifyFleetProof({ proof: peerProof, remoteHello: fixture.peerHello, pinnedPublicKey: fixture.peer.publicKey, challenge: fromHub.challenge });
});

test('Given a signed challenge, when any bound transcript field changes, then proof verification fails', async () => {
  const fixture = hellos();
  const original = negotiateFleetChallenge(fixture.hubHello, fixture.peerHello, fixture.peer.signer.installationId);
  const proof = await createFleetProof({ signer: fixture.peer.signer, role: 'peer', connectionId: fixture.peerHello.connectionId, challenge: original.challenge });
  const fields = [
    { ...fixture.peerHello, processEpoch: 'changed-epoch' },
    { ...fixture.peerHello, nonce: 'A'.repeat(43) },
    { ...fixture.peerHello, capabilities: ['catalog.read'] as const },
    { ...fixture.peerHello, transportMode: 'ssh-loopback' as const },
  ];

  for (const changed of fields) {
    if (changed.transportMode !== fixture.hubHello.transportMode) {
      assert.throws(() => negotiateFleetChallenge(fixture.hubHello, changed, fixture.peer.signer.installationId), /transport modes differ/);
      continue;
    }
    const altered = negotiateFleetChallenge(fixture.hubHello, changed, fixture.peer.signer.installationId);
    assert.throws(
      () => verifyFleetProof({ proof, remoteHello: changed, pinnedPublicKey: fixture.peer.publicKey, challenge: altered.challenge }),
      /proof is invalid/,
    );
  }
});

test('Given an unpinned or wrong key, when proof is checked, then authentication fails closed', async () => {
  const fixture = hellos();
  const impostor = identity();
  const negotiation = negotiateFleetChallenge(fixture.hubHello, fixture.peerHello, fixture.peer.signer.installationId);
  const proof = await createFleetProof({ signer: fixture.peer.signer, role: 'peer', connectionId: fixture.peerHello.connectionId, challenge: negotiation.challenge });

  assert.throws(() => negotiateFleetChallenge(fixture.hubHello, fixture.peerHello, impostor.signer.installationId), /not pinned/);
  assert.throws(
    () => verifyFleetProof({ proof, remoteHello: fixture.peerHello, pinnedPublicKey: impostor.publicKey, challenge: negotiation.challenge }),
    /proof is invalid/,
  );
});

test('Given an authentication clock, when five seconds elapse, then auth expires deterministically', () => {
  const deadline = new FleetAuthDeadline(1_000);

  deadline.assertOpen(1_000 + FLEET_AUTH_DEADLINE_MS - 1);
  assert.throws(() => deadline.assertOpen(1_000 + FLEET_AUTH_DEADLINE_MS), /deadline exceeded/);
});

test('Given unknown or revoked installation trust, when auth admission runs, then it fails without key disclosure', async () => {
  const { requireAuthorizedFleetPeer } = await import('../protocol/auth.js');
  const unknown = { find: async () => undefined };
  const revoked = {
    find: async (installationId: string) => ({ installationId, pinnedPublicKey: 'sensitive-key', state: 'revoked' as const }),
  };

  await assert.rejects(() => requireAuthorizedFleetPeer(unknown, randomUUID()), /not authorized/);
  await assert.rejects(
    () => requireAuthorizedFleetPeer(revoked, randomUUID()),
    (error: unknown) => error instanceof Error && !error.message.includes('sensitive-key'),
  );
});
