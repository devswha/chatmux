import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { createPrivateKey, sign } from 'node:crypto';
import path from 'node:path';

import Database from 'better-sqlite3';

import { getDatabasePath } from '@/modules/database/index.js';
import type {
  FleetIdentitySigner,
  FleetPeerTrustStore,
  FleetPinnedInstallation,
} from '@/modules/fleet/protocol/auth.js';
import type { FleetGenerationStore } from '@/modules/fleet/protocol/state-machine.js';
import {
  canonicalPairingIdentity,
  type SignedInstallationIdentity,
} from '@/modules/fleet/services/fleet-pairing.service.js';
import { loadOrCreateInstallationIdentity } from '@/modules/fleet/services/installation-identity.service.js';

import { FLEET_CAPABILITIES, FLEET_PROTOCOL_VERSIONS } from '../../../../shared/fleet.js';

const PRIVATE_KEY_FILE = 'private-key.pem' as const;
const PUBLIC_KEY_FILE = 'public-key.pem' as const;

type GrantRow = Readonly<{ pinned_public_key: string; grant_state: 'active' | 'revoked' }>;
type ConfigRow = Readonly<{ value: unknown }>;

export async function loadFleetPeerSigner(): Promise<FleetIdentitySigner> {
  const dataRoot = path.dirname(getDatabasePath());
  const identity = await loadOrCreateInstallationIdentity(dataRoot);
  const keyPath = path.join(dataRoot, 'installation-identity', PRIVATE_KEY_FILE);
  const handle = await open(keyPath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  let privateKey: string;
  try {
    privateKey = await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
  const key = createPrivateKey(privateKey);
  return {
    installationId: identity.installationId,
    sign: async (challenge) => sign(null, challenge, key),
  };
}

export async function loadFleetSignedIdentity(): Promise<SignedInstallationIdentity> {
  const dataRoot = path.dirname(getDatabasePath());
  // Sequential on purpose: loadFleetPeerSigner also loads the installation
  // identity, and racing two creators against each other lets one side's
  // stale-stage cleanup delete the other's in-flight staging directory.
  const identity = await loadOrCreateInstallationIdentity(dataRoot);
  const signer = await loadFleetPeerSigner();
  const handle = await open(
    path.join(dataRoot, 'installation-identity', PUBLIC_KEY_FILE),
    constants.O_RDONLY | (constants.O_NOFOLLOW || 0),
  );
  let publicKey: string;
  try {
    publicKey = await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
  const descriptor = {
    installationId: identity.installationId,
    publicKeyFingerprint: identity.publicKeyFingerprint,
    protocolVersions: FLEET_PROTOCOL_VERSIONS,
    capabilities: FLEET_CAPABILITIES,
  } as const;
  return {
    descriptor,
    publicKey,
    signature: Buffer.from(await signer.sign(canonicalPairingIdentity(descriptor, publicKey))).toString('base64url'),
  };
}

export class SqliteFleetPeerTrustStore implements FleetPeerTrustStore {
  constructor(
    private readonly db: Database.Database,
    private readonly localInstallationId: string,
  ) {}

  async find(installationId: string): Promise<FleetPinnedInstallation | undefined> {
    const row = this.db.prepare<[string, string], GrantRow>(`SELECT pinned_public_key, grant_state
      FROM fleet_hub_grants WHERE peer_id = ? AND hub_installation_id = ?
      ORDER BY grant_id DESC LIMIT 1`).get(this.localInstallationId, installationId);
    if (row === undefined) return undefined;
    return { installationId, pinnedPublicKey: row.pinned_public_key, state: row.grant_state };
  }
}

export class SqliteFleetGenerationStore implements FleetGenerationStore {
  constructor(
    private readonly db: Database.Database,
    private readonly localInstallationId: string,
  ) {}

  async claimNext(): Promise<number> {
    return this.db.transaction(() => {
      const key = `fleet.peer.connection-generation.${this.localInstallationId}`;
      const row = this.db.prepare<[string], ConfigRow>('SELECT value FROM app_config WHERE key = ?').get(key);
      const current = row === undefined ? 0 : Number(row.value);
      if (!Number.isSafeInteger(current) || current < 0) {
        throw new TypeError('persisted fleet peer generation is invalid');
      }
      const generation = current + 1;
      this.db.prepare(`INSERT INTO app_config (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, String(generation));
      return generation;
    })();
  }
}
