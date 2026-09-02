import { isIP } from 'node:net';

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

const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;

/*
 * The health probe host is deliberately NOT part of the persisted descriptor:
 * every release parses the shared update state with a closed key set, so a
 * new field would make the state unreadable to the prior release right after
 * a rollback. The router hands it to the worker as CHATMUX_HEALTH_HOST.
 */

/** True for an IP literal (no brackets) or a plain DNS hostname. */
export function isHealthProbeHost(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && (isIP(value) !== 0 || HOSTNAME.test(value));
}

/**
 * Maps the configured bind address to the address the updater must probe.
 * Wildcard binds are reachable on loopback; anything else is probed as bound.
 * Unrecognized values fall back to loopback rather than failing the update.
 */
export function resolveHealthProbeHost(bindHost: unknown): string {
  if (typeof bindHost !== 'string') return '127.0.0.1';
  const trimmed = bindHost.trim().replace(/^\[(.*)\]$/, '$1');
  if (!trimmed || trimmed === '0.0.0.0' || trimmed === '::' || trimmed === 'localhost') return '127.0.0.1';
  return isHealthProbeHost(trimmed) ? trimmed : '127.0.0.1';
}

/** Host as it appears in a URL authority: IPv6 literals need brackets. */
export function formatHealthProbeHost(host: string): string {
  return isIP(host) === 6 ? `[${host}]` : host;
}

export interface SanitizedUpdateJobStatus {
  id: string;
  phase: ReleaseUpdatePhase;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  targetVersion: string;
  error?: string;
  progress?: { downloadedBytes: number; totalBytes?: number };
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
  // schemaGeneration is release-governance bookkeeping validated by the release
  // workflow; it is accepted here so governed releases stay discoverable, then
  // stripped because the updater derives nothing from it.
  if (!closedObject(value, ['database']) || !closedObject(value.database, ['rollbackCompatibleFrom', 'schemaGeneration'])) return null;
  const { rollbackCompatibleFrom: versions, schemaGeneration } = value.database;
  if (schemaGeneration !== undefined && (typeof schemaGeneration !== 'number' || !Number.isSafeInteger(schemaGeneration) || schemaGeneration < 0)) return null;
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

/**
 * The three assets the updater consumes must each be present exactly once.
 * Additional assets are tolerated only when derived from the archive name
 * (`<archive>.sha256.sig`, an attestation, …): a future release can ship a
 * signature without stranding installs on this version, while an asset with an
 * unrelated name still fails closed. The updater never downloads an extra asset.
 */
export function hasCanonicalReleaseAssetSet(names: readonly string[], archiveName: string): boolean {
  const required = [archiveName, `${archiveName}.sha256`, 'install.sh'];
  if (new Set(names).size !== names.length) return false;
  if (required.some((name) => !names.includes(name))) return false;
  return names.every((name) => required.includes(name) || name.startsWith(`${archiveName}.`));
}

/**
 * Parses a `sha256sum`-style checksum file and returns the archive's digest.
 * Every non-empty line must be `<64 hex><spaces>[*]<name>`, and exactly one
 * line may name the archive; further lines (a bootstrap script hash, for
 * instance) are allowed but never consumed. Shared with the update worker so
 * discovery and apply cannot disagree about what a valid file looks like.
 */
export function parseReleaseChecksumFile(text: string, archiveName: string): string | null {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  if (lines.length === 0) return null;
  let digest: string | null = null;
  for (const line of lines) {
    const entry = /^([a-f0-9]{64})\s+\*?(\S.*)$/.exec(line);
    if (!entry) return null;
    if (entry[2] !== archiveName) continue;
    if (digest !== null) return null;
    digest = entry[1];
  }
  return digest;
}
