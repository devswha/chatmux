import { lstat } from 'node:fs/promises';
import path from 'node:path';

import {
  closeConnection,
  fleetHubGrantsDb,
  fleetPeersDb,
  getConnection,
  getDatabasePath,
  initializeDatabase,
} from '@/modules/database/index.js';
import { loadFleetSignedIdentity } from '@/modules/fleet/peer/persistence.js';
import { FleetPairingService } from '@/modules/fleet/services/fleet-pairing.service.js';
import { SqliteFleetPairingStore } from '@/modules/fleet/services/fleet-pairing-store.service.js';
import { loadOrCreateInstallationIdentity } from '@/modules/fleet/services/installation-identity.service.js';

import {
  probeFleetConnectivity,
  type FleetConnectivityResult,
  type FleetConnectivityTarget,
} from './fleet-cli-connectivity.js';

const INSTALLATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export type FleetCliCommand =
  | Readonly<{ readonly kind: 'identity' }>
  | Readonly<{ readonly kind: 'token' }>
  | Readonly<{ readonly kind: 'grants' }>
  | Readonly<{ readonly kind: 'revoke'; readonly installationId: string }>
  | Readonly<{ readonly kind: 'diagnose' }>
  | Readonly<{ readonly kind: 'help' }>;

type FleetCliContext = Readonly<{
  readonly output?: (line: string) => void;
  readonly effectiveUid?: () => number;
  readonly probe?: (target: FleetConnectivityTarget) => Promise<FleetConnectivityResult>;
}>;

export class FleetCliError extends Error {
  readonly name = 'FleetCliError';
}

function usageError(): FleetCliError {
  return new FleetCliError('Usage: chatmux fleet identity | token | grants | revoke <installation-id> | diagnose');
}

export function parseFleetCliCommand(args: readonly string[]): FleetCliCommand {
  const [command, ...rest] = args;
  switch (command) {
    case 'identity':
    case 'token':
    case 'grants':
    case 'diagnose':
      if (rest.length !== 0) throw usageError();
      return { kind: command };
    case 'revoke': {
      const [installationId] = rest;
      if (rest.length !== 1 || installationId === undefined || !INSTALLATION_ID.test(installationId)) {
        throw new FleetCliError('revoke requires one canonical installation ID');
      }
      return { kind: 'revoke', installationId };
    }
    case 'help':
    case undefined:
      if (rest.length !== 0) throw usageError();
      return { kind: 'help' };
    default:
      throw usageError();
  }
}

async function assertDataOwner(effectiveUid: () => number): Promise<void> {
  const dataRoot = path.dirname(getDatabasePath());
  const stats = await lstat(dataRoot);
  if (!stats.isDirectory() || stats.isSymbolicLink() || stats.uid !== effectiveUid() || (stats.mode & 0o077) !== 0) {
    throw new FleetCliError('fleet grant commands require an owner-only installation data directory');
  }
}

function printHelp(output: (line: string) => void): void {
  output('Usage: chatmux fleet <command>');
  output('  identity              Print the public installation fingerprint');
  output('  token                 Create one owner-only 10-minute pairing token');
  output('  grants                List public grant metadata');
  output('  revoke <installation-id>  Revoke a local fleet grant');
  output('  diagnose              Check configured peer connectivity without secrets');
}

function printGrants(output: (line: string) => void): void {
  const inbound = fleetHubGrantsDb.list();
  const outbound = fleetPeersDb.list();
  if (inbound.length === 0 && outbound.length === 0) {
    output('No fleet grants.');
    return;
  }
  for (const grant of inbound) {
    output(`hub ${grant.hubInstallationId} ${grant.pinnedPublicKeyFingerprint} ${grant.grantState}`);
  }
  for (const peer of outbound) {
    output(`peer ${peer.peerId} ${peer.pinnedPublicKeyFingerprint} ${peer.enrollmentState}`);
  }
}

async function diagnose(
  output: (line: string) => void,
  probe: (target: FleetConnectivityTarget) => Promise<FleetConnectivityResult>,
): Promise<void> {
  const peers = fleetPeersDb.list().filter((peer) => peer.enrollmentState === 'enrolled');
  if (peers.length === 0) {
    output('No enrolled peers. Local operation is unchanged.');
    return;
  }
  for (const peer of peers) {
    const result = await probe({ url: peer.url, transportMode: peer.transportMode });
    output(`${peer.peerId} ${peer.pinnedPublicKeyFingerprint} ${result.reachable ? 'reachable' : result.detail}`);
  }
}

export async function runFleetCli(args: readonly string[], context: FleetCliContext = {}): Promise<void> {
  const command = parseFleetCliCommand(args);
  const output = context.output ?? console.log;
  if (command.kind === 'help') {
    printHelp(output);
    return;
  }
  await initializeDatabase();
  try {
    switch (command.kind) {
      case 'identity': {
        const identity = await loadOrCreateInstallationIdentity();
        output(`Installation: ${identity.installationId}`);
        output(`Fingerprint: ${identity.publicKeyFingerprint}`);
        return;
      }
      case 'token': {
        await assertDataOwner(context.effectiveUid ?? (() => {
          if (typeof process.geteuid !== 'function') throw new FleetCliError('fleet token issuance requires a local effective user');
          return process.geteuid();
        }));
        const pairing = new FleetPairingService({
          store: new SqliteFleetPairingStore(getConnection()),
          identity: await loadFleetSignedIdentity(),
        });
        const issued = pairing.issueToken();
        output(`Pairing token: ${issued.token}`);
        output(`Expires at: ${new Date(issued.expiresAtMs).toISOString()}`);
        return;
      }
      case 'grants':
        printGrants(output);
        return;
      case 'revoke': {
        await assertDataOwner(context.effectiveUid ?? (() => {
          if (typeof process.geteuid !== 'function') throw new FleetCliError('fleet revocation requires a local effective user');
          return process.geteuid();
        }));
        const peer = fleetPeersDb.find(command.installationId);
        const revoked = peer?.enrollmentState === 'enrolled'
          ? fleetPeersDb.revoke(command.installationId, Date.now())
          : fleetHubGrantsDb.revokeActiveHub(command.installationId, Date.now());
        if (revoked === undefined) throw new FleetCliError('no active grant exists for that installation');
        output(`Revoked: ${command.installationId}`);
        return;
      }
      case 'diagnose':
        await diagnose(output, context.probe ?? probeFleetConnectivity);
        return;
    }
  } finally {
    closeConnection();
  }
}
