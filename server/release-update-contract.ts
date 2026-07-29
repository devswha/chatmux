export const CANONICAL_RELEASE_REPOSITORY = 'devswha/chatmux' as const;
export const RELEASE_PLATFORM = 'linux-x64-node22' as const;
export const RELEASE_BOOTSTRAP_ASSET = 'install.sh' as const;

export type ReleaseUpdatePhase =
  | 'queued'
  | 'downloading'
  | 'verifying'
  | 'staging'
  | 'cutting_over'
  | 'restarting'
  | 'verifying_health'
  | 'rolling_back'
  | 'succeeded'
  | 'failed'
  | 'failed_rolled_back'
  | 'failed_rollback'
  | 'manual_required';

export const ACTIVE_UPDATE_PHASES: readonly ReleaseUpdatePhase[] = [
  'queued', 'downloading', 'verifying', 'staging', 'cutting_over', 'restarting', 'verifying_health', 'rolling_back',
];
export const TERMINAL_UPDATE_PHASES: readonly ReleaseUpdatePhase[] = [
  'succeeded', 'failed', 'failed_rolled_back', 'failed_rollback', 'manual_required',
];

export interface StrictSemVer {
  major: number;
  minor: number;
  patch: number;
  version: string;
}

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const JOB_ID = /^[A-Za-z0-9_-]{22}$/;
const SHA256 = /^[a-f0-9]{64}$/;

export function parseStrictSemVer(value: unknown): StrictSemVer | null {
  if (typeof value !== 'string') return null;
  const match = SEMVER.exec(value);
  if (!match) return null;
  const [major, minor, patch] = match.slice(1).map(Number);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) return null;
  return { major, minor, patch, version: value };
}

export function compareStrictSemVer(left: string, right: string): number | null {
  const a = parseStrictSemVer(left);
  const b = parseStrictSemVer(right);
  if (!a || !b) return null;
  for (const [aPart, bPart] of [[a.major, b.major], [a.minor, b.minor], [a.patch, b.patch]] as const) {
    if (aPart !== bPart) return aPart > bPart ? 1 : -1;
  }
  return 0;
}

export function isOpaqueUpdateJobId(value: unknown): value is string {
  return typeof value === 'string' && JOB_ID.test(value);
}

export function archiveNameForVersion(version: string): string | null {
  return parseStrictSemVer(version) ? `chatmux-server-${version}-${RELEASE_PLATFORM}.tar.gz` : null;
}

export interface ReleaseDescriptor {
  repository: typeof CANONICAL_RELEASE_REPOSITORY;
  tag: string;
  version: string;
  archiveName: string;
  checksumName: string;
  bootstrapName: typeof RELEASE_BOOTSTRAP_ASSET;
  archiveSha256: string;
  publishedAt: string;
}

export interface CompatibilityMetadata {
  database: { rollbackCompatibleFrom: string[] };
}

export interface ImmutableUpdateJobDescriptor {
  id: string;
  release: ReleaseDescriptor;
  compatibility: CompatibilityMetadata;
  createdAt: number;
  installMode: 'source' | 'release';
  sourceVersion: string;
  sourceBootId: string;
  serverPort: number;
}

export interface SanitizedUpdateJobStatus {
  id: string;
  phase: ReleaseUpdatePhase;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  targetVersion: string;
  error?: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function closedObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return isPlainObject(value) && Object.keys(value).every((key) => keys.includes(key));
}

export function validateReleaseDescriptor(value: unknown): ReleaseDescriptor | null {
  if (!closedObject(value, ['repository', 'tag', 'version', 'archiveName', 'checksumName', 'bootstrapName', 'archiveSha256', 'publishedAt'])) return null;
  const { repository, tag, version, archiveName: receivedArchiveName, checksumName, bootstrapName, archiveSha256, publishedAt } = value;
  if (typeof version !== 'string' || repository !== CANONICAL_RELEASE_REPOSITORY || !parseStrictSemVer(version)) return null;
  const archiveName = archiveNameForVersion(version);
  if (!archiveName || tag !== `v${version}` || receivedArchiveName !== archiveName || checksumName !== `${archiveName}.sha256` || bootstrapName !== RELEASE_BOOTSTRAP_ASSET) return null;
  if (typeof archiveSha256 !== 'string' || !SHA256.test(archiveSha256)) return null;
  if (typeof publishedAt !== 'string' || !Number.isFinite(Date.parse(publishedAt))) return null;
  return {
    repository: CANONICAL_RELEASE_REPOSITORY,
    tag: `v${version}`,
    version,
    archiveName,
    checksumName: `${archiveName}.sha256`,
    bootstrapName: RELEASE_BOOTSTRAP_ASSET,
    archiveSha256,
    publishedAt,
  };
}

export function validateCompatibilityMetadata(value: unknown): CompatibilityMetadata | null {
  if (!closedObject(value, ['database']) || !closedObject(value.database, ['rollbackCompatibleFrom'])) return null;
  const versions = value.database.rollbackCompatibleFrom;
  if (!Array.isArray(versions) || versions.some((version) => !parseStrictSemVer(version)) || new Set(versions).size !== versions.length) return null;
  return { database: { rollbackCompatibleFrom: [...versions] } };
}

export function validateImmutableUpdateJobDescriptor(value: unknown): ImmutableUpdateJobDescriptor | null {
  if (!closedObject(value, ['id', 'release', 'compatibility', 'createdAt', 'installMode', 'sourceVersion', 'sourceBootId', 'serverPort'])) return null;
  const { id, createdAt, installMode, sourceVersion, sourceBootId, serverPort } = value;
  const release = validateReleaseDescriptor(value.release);
  const compatibility = validateCompatibilityMetadata(value.compatibility);
  if (!isOpaqueUpdateJobId(id) || !release || !compatibility || typeof createdAt !== 'number' || !Number.isSafeInteger(createdAt) || createdAt < 0 || (installMode !== 'source' && installMode !== 'release') || typeof sourceVersion !== 'string' || !parseStrictSemVer(sourceVersion) || typeof sourceBootId !== 'string' || !sourceBootId.trim() || sourceBootId.length > 200 || /[\0\r\n]/.test(sourceBootId) || typeof serverPort !== 'number' || !Number.isSafeInteger(serverPort) || serverPort < 1 || serverPort > 65535) return null;
  return { id, release, compatibility, createdAt, installMode, sourceVersion, sourceBootId, serverPort };
}

export function isUpdatePhase(value: unknown): value is ReleaseUpdatePhase {
  return typeof value === 'string' && ([...ACTIVE_UPDATE_PHASES, ...TERMINAL_UPDATE_PHASES] as string[]).includes(value);
}

export function isTerminalUpdatePhase(phase: ReleaseUpdatePhase): boolean {
  return (TERMINAL_UPDATE_PHASES as readonly string[]).includes(phase);
}

export function sanitizePublicUpdateError(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.replace(/[\r\n\t]+/g, ' ').trim().replace(/\s+/g, ' ');
  if (!normalized) return undefined;
  return normalized.replace(/(?:\/[^\s]+|[A-Za-z]:\\[^\s]+|https?:\/\/[^\s]+|\b(?:token|secret|password)=\S+)/gi, '[redacted]').slice(0, 240);
}
