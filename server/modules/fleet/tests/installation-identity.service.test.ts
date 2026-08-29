import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import { getDatabasePath } from '@/modules/database/index.js';
import { InstallationIdentityError, loadOrCreateInstallationIdentity } from '@/modules/fleet/services/installation-identity.service.js';

const temporaryRoots: string[] = [];
const IDENTITY_DIRECTORY = 'installation-identity';

async function temporaryRoot(label: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), `chatmux-identity-${label}-`));
  temporaryRoots.push(root);
  return root;
}

async function expectIdentityError(
  action: () => Promise<unknown>,
  code: InstallationIdentityError['code'],
  forbiddenText?: string,
): Promise<void> {
  await assert.rejects(action, (error: unknown) => {
    assert.ok(error instanceof InstallationIdentityError);
    assert.equal(error.code, code);
    if (forbiddenText !== undefined) {
      assert.doesNotMatch(`${error.name}: ${error.message}`, /PRIVATE KEY|PUBLIC KEY/);
      assert.ok(!error.message.includes(forbiddenText));
    }
    return true;
  });
}

after(async () => {
  await Promise.all(temporaryRoots.map((root) => rm(root, { recursive: true, force: true })));
});

test('uses the database parent as the current data root when DATABASE_PATH is configured', async () => {
  // Given
  const root = await temporaryRoot('data-root');
  const previousDatabasePath = process.env.DATABASE_PATH;
  process.env.DATABASE_PATH = path.join(root, 'auth.db');

  try {
    // When
    const dataRoot = path.dirname(getDatabasePath());

    // Then
    assert.equal(dataRoot, root);
  } finally {
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
  }
});

test('creates one durable public identity with owner-only modes on first start', async () => {
  // Given
  const root = await temporaryRoot('first-start');

  // When
  const first = await loadOrCreateInstallationIdentity(root);
  const second = await loadOrCreateInstallationIdentity(root);

  // Then
  assert.deepEqual(second, first);
  assert.match(first.installationId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.match(first.publicKeyFingerprint, /^SHA256:[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(Object.keys(first).sort(), ['installationId', 'publicKeyFingerprint']);
  const identityRoot = path.join(root, IDENTITY_DIRECTORY);
  assert.equal((await lstat(identityRoot)).mode & 0o777, 0o700);
  const files = await readdir(identityRoot);
  assert.deepEqual(files.sort(), ['installation-id', 'private-key.pem', 'public-key.pem']);
  for (const file of files) assert.equal((await lstat(path.join(identityRoot, file))).mode & 0o777, 0o600);
});

test('refuses partial final state instead of silently replacing identity', async () => {
  // Given
  const root = await temporaryRoot('partial');
  const identityRoot = path.join(root, IDENTITY_DIRECTORY);
  await mkdir(identityRoot, { mode: 0o700 });
  await writeFile(path.join(identityRoot, 'installation-id'), '00000000-0000-4000-8000-000000000000\n', { mode: 0o600 });

  // When / Then
  await expectIdentityError(() => loadOrCreateInstallationIdentity(root), 'IDENTITY_STATE_INCOMPLETE');
});

test('recovers atomically when interrupted staging directories remain', async () => {
  // Given
  const root = await temporaryRoot('stale-stage');
  const stale = path.join(root, '.installation-identity-00000000-0000-4000-8000-000000000001.tmp');
  const unrelated = path.join(root, '.installation-identity-interrupted.tmp');
  await mkdir(stale, { mode: 0o700 });
  await writeFile(path.join(stale, 'private-key.pem'), 'partial secret', { mode: 0o600 });
  await mkdir(unrelated, { mode: 0o700 });

  // When
  const identity = await loadOrCreateInstallationIdentity(root);

  // Then
  assert.match(identity.installationId, /^[0-9a-f-]{36}$/);
  assert.equal((await readFile(path.join(root, IDENTITY_DIRECTORY, 'installation-id'), 'utf8')).trim(), identity.installationId);
  await assert.rejects(lstat(stale), { code: 'ENOENT' });
  assert.ok((await lstat(unrelated)).isDirectory());
});

test('refuses symlinked roots and identity entries without following them', async () => {
  // Given
  const parent = await temporaryRoot('symlink');
  const outside = await temporaryRoot('outside');
  const linkedRoot = path.join(parent, 'linked-root');
  await symlink(outside, linkedRoot, 'dir');

  // When / Then
  await expectIdentityError(() => loadOrCreateInstallationIdentity(linkedRoot), 'IDENTITY_PATH_UNSAFE');
  const identityLink = path.join(parent, IDENTITY_DIRECTORY);
  await symlink(outside, identityLink, 'dir');
  await expectIdentityError(() => loadOrCreateInstallationIdentity(parent), 'IDENTITY_PATH_UNSAFE');
  assert.deepEqual(await readdir(outside), []);
});

test('refuses permissive identity directory and file modes', async () => {
  // Given
  const directoryRoot = await temporaryRoot('directory-mode');
  await loadOrCreateInstallationIdentity(directoryRoot);
  await chmod(path.join(directoryRoot, IDENTITY_DIRECTORY), 0o755);

  // When / Then
  await expectIdentityError(() => loadOrCreateInstallationIdentity(directoryRoot), 'IDENTITY_PERMISSIONS_UNSAFE');

  // Given
  const fileRoot = await temporaryRoot('file-mode');
  await loadOrCreateInstallationIdentity(fileRoot);
  await chmod(path.join(fileRoot, IDENTITY_DIRECTORY, 'private-key.pem'), 0o644);

  // When / Then
  await expectIdentityError(() => loadOrCreateInstallationIdentity(fileRoot), 'IDENTITY_PERMISSIONS_UNSAFE');
});

test('refuses malformed state and a public key changed independently of its private key', async () => {
  // Given
  const malformedRoot = await temporaryRoot('malformed');
  await loadOrCreateInstallationIdentity(malformedRoot);
  const malformedId = path.join(malformedRoot, IDENTITY_DIRECTORY, 'installation-id');
  await writeFile(malformedId, '../outside\n', { mode: 0o600 });

  // When / Then
  await expectIdentityError(() => loadOrCreateInstallationIdentity(malformedRoot), 'IDENTITY_STATE_INVALID');

  // Given
  const changedRoot = await temporaryRoot('changed-key');
  const identity = await loadOrCreateInstallationIdentity(changedRoot);
  const replacement = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' });
  await writeFile(path.join(changedRoot, IDENTITY_DIRECTORY, 'public-key.pem'), replacement, { mode: 0o600 });

  // When / Then
  await expectIdentityError(
    () => loadOrCreateInstallationIdentity(changedRoot),
    'IDENTITY_KEY_MISMATCH',
    identity.publicKeyFingerprint,
  );
});

test('refuses a symlink substituted for an existing private key', async () => {
  // Given
  const root = await temporaryRoot('key-symlink');
  await loadOrCreateInstallationIdentity(root);
  const privateKey = path.join(root, IDENTITY_DIRECTORY, 'private-key.pem');
  await unlink(privateKey);
  await symlink('/etc/passwd', privateKey);

  // When / Then
  await expectIdentityError(() => loadOrCreateInstallationIdentity(root), 'IDENTITY_PATH_UNSAFE');
});
