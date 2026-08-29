import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, fleetPeersDb, initializeDatabase } from '@/modules/database/index.js';

import { FleetCliError, parseFleetCliCommand, runFleetCli } from './fleet-cli.js';

const PEER_ID = '10000000-0000-4000-8000-000000000001';

async function withDatabase(
  label: string,
  action: (root: string, lines: string[]) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), `chatmux-fleet-cli-${label}-`));
  const previous = process.env.DATABASE_PATH;
  process.env.DATABASE_PATH = path.join(root, 'auth.db');
  const lines: string[] = [];
  try {
    await action(root, lines);
  } finally {
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
    await rm(root, { recursive: true, force: true });
  }
}

test('Given fleet CLI input, when a command is malformed, then it fails before persistence', () => {
  assert.throws(() => parseFleetCliCommand(['revoke', 'not-an-installation']), FleetCliError);
  assert.throws(() => parseFleetCliCommand(['token', 'extra']), FleetCliError);
  assert.deepEqual(parseFleetCliCommand(['diagnose']), { kind: 'diagnose' });
});

test('Given a new installation, when identity is read across restarts, then one public fingerprint persists', { concurrency: false }, async () => {
  await withDatabase('identity', async (_root, lines) => {
    // Given / When
    await runFleetCli(['identity'], { output: (line) => lines.push(line) });
    await runFleetCli(['identity'], { output: (line) => lines.push(line) });

    // Then
    assert.equal(lines.length, 4);
    assert.equal(lines[0], lines[2]);
    assert.equal(lines[1], lines[3]);
    assert.match(lines[1] ?? '', /^Fingerprint: SHA256:[A-Za-z0-9_-]{43}$/u);
  });
});

test('Given owner-only data, when a token is issued, then only the one-time token and expiry are printed', { concurrency: false }, async () => {
  await withDatabase('token', async (_root, lines) => {
    // Given / When
    await runFleetCli(['token'], { output: (line) => lines.push(line) });

    // Then
    assert.match(lines[0] ?? '', /^Pairing token: [A-Za-z0-9_-]{43}$/u);
    assert.match(lines[1] ?? '', /^Expires at: /u);
    assert.doesNotMatch(lines.join('\n'), /PRIVATE KEY|token_hash|private-key|public-key/u);
  });
});

test('Given permissive installation data, when a token is requested, then owner authorization fails closed', { concurrency: false }, async () => {
  await withDatabase('permissions', async (root, lines) => {
    // Given
    await chmod(root, 0o755);

    // When / Then
    await assert.rejects(
      runFleetCli(['token'], { output: (line) => lines.push(line) }),
      /owner-only installation data directory/u,
    );
    assert.deepEqual(lines, []);
  });
});

test('Given a configured peer, when grants and diagnostics run, then secrets and addresses stay redacted', { concurrency: false }, async () => {
  await withDatabase('diagnose', async (_root, lines) => {
    // Given
    await initializeDatabase();
    const enrolled = fleetPeersDb.enroll({
      peerId: PEER_ID,
      url: 'wss://secret-host.example/fleet-ws',
      transportMode: 'direct-wss',
      displayLabel: 'Workstation',
      pinnedPublicKey: 'SECRET PUBLIC KEY MATERIAL',
      pinnedPublicKeyFingerprint: 'SHA256:peer-public',
    }, 1_800_000_000_000);
    assert.equal(enrolled.ok, true);
    closeConnection();

    // When
    await runFleetCli(['grants'], { output: (line) => lines.push(line) });
    await runFleetCli(['diagnose'], {
      output: (line) => lines.push(line),
      probe: async () => ({ reachable: false, detail: 'refused' }),
    });

    // Then
    const output = lines.join('\n');
    assert.match(output, new RegExp(PEER_ID, 'u'));
    assert.match(output, /SHA256:peer-public/u);
    assert.match(output, /refused/u);
    assert.doesNotMatch(output, /secret-host|SECRET PUBLIC KEY|wss:\/\//u);
  });
});

test('Given an active peer grant, when its installation ID is revoked, then the public grant state changes', { concurrency: false }, async () => {
  await withDatabase('revoke', async (_root, lines) => {
    // Given
    await initializeDatabase();
    fleetPeersDb.enroll({
      peerId: PEER_ID,
      url: 'wss://peer.example/fleet-ws',
      transportMode: 'direct-wss',
      displayLabel: 'Peer',
      pinnedPublicKey: 'public-key',
      pinnedPublicKeyFingerprint: 'SHA256:peer',
    }, 1_800_000_000_000);
    closeConnection();

    // When
    await runFleetCli(['revoke', PEER_ID], { output: (line) => lines.push(line) });
    await runFleetCli(['grants'], { output: (line) => lines.push(line) });

    // Then
    assert.deepEqual(lines, [`Revoked: ${PEER_ID}`, `peer ${PEER_ID} SHA256:peer revoked`]);
  });
});

test('Given no peers, when diagnostics run, then local-only operation remains explicit', { concurrency: false }, async () => {
  await withDatabase('empty', async (_root, lines) => {
    // Given / When
    await runFleetCli(['diagnose'], { output: (line) => lines.push(line) });

    // Then
    assert.deepEqual(lines, ['No enrolled peers. Local operation is unchanged.']);
  });
});
