import {
  constants,
  type Stats,
} from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  realpath,
  readdir,
  rename,
  rm,
} from 'node:fs/promises';
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
} from 'node:crypto';
import path from 'node:path';

import { getDatabasePath } from '@/modules/database/index.js';

const IDENTITY_DIRECTORY = 'installation-identity' as const;
const ID_FILE = 'installation-id' as const;
const PRIVATE_KEY_FILE = 'private-key.pem' as const;
const PUBLIC_KEY_FILE = 'public-key.pem' as const;
const REQUIRED_FILES = [ID_FILE, PRIVATE_KEY_FILE, PUBLIC_KEY_FILE] as const;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STAGING_DIRECTORY = /^\.installation-identity-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/;

export type InstallationIdentityErrorCode =
  | 'IDENTITY_PATH_UNSAFE'
  | 'IDENTITY_PERMISSIONS_UNSAFE'
  | 'IDENTITY_STATE_INCOMPLETE'
  | 'IDENTITY_STATE_INVALID'
  | 'IDENTITY_KEY_MISMATCH';

export type InstallationPublicIdentity = Readonly<{
  readonly installationId: string;
  readonly publicKeyFingerprint: string;
}>;

export class InstallationIdentityError extends Error {
  readonly name = 'InstallationIdentityError';

  constructor(
    readonly code: InstallationIdentityErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

function errnoCode(error: unknown): string | undefined {
  if (!(error instanceof Error) || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

function assertMode(stats: Stats, expected: number, subject: string): void {
  if ((stats.mode & 0o777) !== expected) {
    throw new InstallationIdentityError(
      'IDENTITY_PERMISSIONS_UNSAFE',
      `${subject} must have mode ${expected.toString(8)}`,
    );
  }
}

async function assertSafeDataRoot(dataRoot: string): Promise<string> {
  const absoluteRoot = path.resolve(dataRoot);
  await mkdir(absoluteRoot, { recursive: true, mode: 0o700 });
  const stats = await lstat(absoluteRoot);
  if (!stats.isDirectory() || stats.isSymbolicLink() || await realpath(absoluteRoot) !== absoluteRoot) {
    throw new InstallationIdentityError('IDENTITY_PATH_UNSAFE', 'installation data root is unsafe');
  }
  return absoluteRoot;
}

async function existingIdentityStats(identityRoot: string): Promise<Stats | null> {
  try {
    return await lstat(identityRoot);
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return null;
    throw error;
  }
}

async function readSecureFile(identityRoot: string, fileName: string): Promise<string> {
  const filePath = path.join(identityRoot, fileName);
  const expectedStats = await lstat(filePath);
  if (!expectedStats.isFile() || expectedStats.isSymbolicLink()) {
    throw new InstallationIdentityError('IDENTITY_PATH_UNSAFE', `${fileName} is not a regular file`);
  }
  assertMode(expectedStats, 0o600, fileName);
  const handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const openedStats = await handle.stat();
    if (openedStats.dev !== expectedStats.dev || openedStats.ino !== expectedStats.ino) {
      throw new InstallationIdentityError('IDENTITY_PATH_UNSAFE', `${fileName} changed while opening`);
    }
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

function publicKeyDer(key: string): Buffer {
  try {
    return createPublicKey(key).export({ type: 'spki', format: 'der' });
  } catch (error) {
    if (error instanceof Error) {
      throw new InstallationIdentityError('IDENTITY_STATE_INVALID', 'installation public key is invalid', { cause: error });
    }
    throw error;
  }
}

async function loadIdentity(identityRoot: string, stats: Stats): Promise<InstallationPublicIdentity> {
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new InstallationIdentityError('IDENTITY_PATH_UNSAFE', 'installation identity path is unsafe');
  }
  assertMode(stats, 0o700, 'installation identity directory');
  const files = await readdir(identityRoot);
  if (REQUIRED_FILES.some((file) => !files.includes(file))) {
    throw new InstallationIdentityError('IDENTITY_STATE_INCOMPLETE', 'installation identity files are incomplete');
  }
  if (files.length !== REQUIRED_FILES.length) {
    throw new InstallationIdentityError('IDENTITY_STATE_INVALID', 'installation identity directory has unexpected files');
  }
  const [rawId, privateKey, publicKey] = await Promise.all([
    readSecureFile(identityRoot, ID_FILE),
    readSecureFile(identityRoot, PRIVATE_KEY_FILE),
    readSecureFile(identityRoot, PUBLIC_KEY_FILE),
  ]);
  const installationId = rawId.trim();
  if (!UUID_V4.test(installationId)) {
    throw new InstallationIdentityError('IDENTITY_STATE_INVALID', 'installation ID is invalid');
  }
  let derivedPublicKey: Buffer;
  try {
    derivedPublicKey = createPublicKey(createPrivateKey(privateKey)).export({ type: 'spki', format: 'der' });
  } catch (error) {
    if (error instanceof Error) {
      throw new InstallationIdentityError('IDENTITY_STATE_INVALID', 'installation private key is invalid', { cause: error });
    }
    throw error;
  }
  const persistedPublicKey = publicKeyDer(publicKey);
  if (!derivedPublicKey.equals(persistedPublicKey)) {
    throw new InstallationIdentityError('IDENTITY_KEY_MISMATCH', 'installation key pair does not match');
  }
  return {
    installationId,
    publicKeyFingerprint: `SHA256:${createHash('sha256').update(persistedPublicKey).digest('base64url')}`,
  };
}

async function writeSecureFile(directory: string, fileName: string, contents: string): Promise<void> {
  const filePath = path.join(directory, fileName);
  const handle = await open(
    filePath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0),
    0o600,
  );
  try {
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function removeStaleStages(dataRoot: string): Promise<void> {
  const entries = await readdir(dataRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!STAGING_DIRECTORY.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) continue;
    const stagingPath = path.join(dataRoot, entry.name);
    const stats = await existingIdentityStats(stagingPath);
    if (!stats || !stats.isDirectory() || stats.isSymbolicLink() || (stats.mode & 0o777) !== 0o700) continue;
    await rm(stagingPath, { recursive: true });
  }
}

async function createIdentity(dataRoot: string, identityRoot: string): Promise<void> {
  const stage = path.join(dataRoot, `.installation-identity-${randomUUID()}.tmp`);
  await mkdir(stage, { mode: 0o700 });
  try {
    const installationId = randomUUID();
    const { privateKey, publicKey } = generateKeyPairSync('ed25519', {
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    await writeSecureFile(stage, ID_FILE, `${installationId}\n`);
    await writeSecureFile(stage, PRIVATE_KEY_FILE, privateKey);
    await writeSecureFile(stage, PUBLIC_KEY_FILE, publicKey);
    await syncDirectory(stage);
    await rename(stage, identityRoot);
    await syncDirectory(dataRoot);
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    if (errnoCode(error) === 'EEXIST' || errnoCode(error) === 'ENOTEMPTY') return;
    throw error;
  }
}

export async function loadOrCreateInstallationIdentity(
  dataRoot = path.dirname(getDatabasePath()),
): Promise<InstallationPublicIdentity> {
  const safeDataRoot = await assertSafeDataRoot(dataRoot);
  const identityRoot = path.join(safeDataRoot, IDENTITY_DIRECTORY);
  const existing = await existingIdentityStats(identityRoot);
  if (!existing) await createIdentity(safeDataRoot, identityRoot);
  const current = existing ?? await existingIdentityStats(identityRoot);
  if (!current) {
    throw new InstallationIdentityError('IDENTITY_STATE_INCOMPLETE', 'installation identity was not persisted');
  }
  const identity = await loadIdentity(identityRoot, current);
  await removeStaleStages(safeDataRoot);
  return identity;
}
