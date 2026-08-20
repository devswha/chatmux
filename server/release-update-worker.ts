import { createHash } from 'node:crypto';
import * as nodeFs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import * as nodePath from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  CANONICAL_RELEASE_REPOSITORY,
  isOpaqueUpdateJobId,
  parseStrictSemVer,
  validateCompatibilityMetadata,
  type CompatibilityMetadata,
  type ImmutableUpdateJobDescriptor,
  type ReleaseUpdatePhase,
} from './release-update-contract.js';
import { ReleaseUpdateStateStore } from './release-update-state.js';

const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const MAX_CHECKSUM_BYTES = 4096;
const MAX_EXPANDED_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 50_000;
const REQUEST_TIMEOUT_MS = 300_000;
const PROCESS_TIMEOUT_MS = 120_000;
const MAX_PROCESS_STDOUT_BYTES = 16 * 1024 * 1024;
const MAX_PROCESS_STDERR_BYTES = 1 * 1024 * 1024;
const HEALTH_ATTEMPTS = 12;
const HEALTH_INTERVAL_MS = 1_000;
const HEALTH_REQUEST_TIMEOUT_MS = 5_000;
const RELEASE_HOSTS = new Set(['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']);
const TAR = '/usr/bin/tar';
const SYSTEMCTL = '/usr/bin/systemctl';

export class ReleaseUpdateWorkerError extends Error {}
export class ManualCompatibilityError extends ReleaseUpdateWorkerError {}
/** Test-only interruption sentinel; never constructed from request data. */
export class ReleaseUpdateWorkerCrash extends Error {}

export interface HttpResponse { status: number; headers: { get(name: string): string | null }; body: AsyncIterable<Uint8Array> }
export interface WorkerFileSystem {
  mkdir(path: string, options?: { recursive?: boolean; mode?: number }): Promise<void>;
  readFile(path: string, encoding?: 'utf8'): Promise<string | Buffer>;
  writeFile(path: string, data: string | Uint8Array, options?: { mode?: number; flag?: string }): Promise<void>;
  lstat(path: string): Promise<{ isDirectory(): boolean; isSymbolicLink(): boolean; isFile(): boolean; mode: number; dev: number; size: number; uid: number }>;
  stat(path: string): Promise<{ isDirectory(): boolean; isFile(): boolean; dev: number; size: number }>;
  readdir(path: string, options: { withFileTypes: true }): Promise<Array<{ name: string; isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean; isBlockDevice(): boolean; isCharacterDevice(): boolean; isFIFO(): boolean; isSocket(): boolean }>>;
  rename(from: string, to: string): Promise<void>;
  rm(path: string, options: { recursive: boolean; force: boolean }): Promise<void>;
  symlink(target: string, path: string): Promise<void>;
  readlink(path: string): Promise<string>;
  realpath(path: string): Promise<string>;
  chmod(path: string, mode: number): Promise<void>;
  access(path: string, mode?: number): Promise<void>;
}
export interface WorkerProcess { (command: string, args: readonly string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv }): Promise<{ code: number; stdout: string; stderr: string }> }
export interface ReleaseUpdateWorkerOptions {
  home?: string;
  fs?: WorkerFileSystem;
  store?: Pick<ReleaseUpdateStateStore, 'get' | 'transition' | 'persistRecoveryCheckpoint' | 'recordDownloadProgress'>;
  fetch?: (url: string, options: { signal: AbortSignal; redirect: 'manual' }) => Promise<HttpResponse>;
  run?: WorkerProcess;
  health?: (expectedVersion: string, serverPort: number, sourceBootId: string) => Promise<boolean>;
  now?: () => number;
  healthTiming?: { fetch?: typeof fetch; sleep?: (milliseconds: number) => Promise<void> };
  requestTimeoutMs?: number;
  /** Test-only durable-boundary interruption seam; not wired to any public input. */
  onDurableBoundary?: (boundary: 'prepared' | 'live_link_swapped' | 'rollback_in_progress' | 'rollback_link_restored' | 'rollback_completed' | 'terminalized') => void;
}

const fs: WorkerFileSystem = nodeFs as unknown as WorkerFileSystem;

function releaseAssetUrl(descriptor: ImmutableUpdateJobDescriptor, name: string): string {
  // The descriptor was created by the router and validates this exact repository/tag; it is not client input.
  return `https://github.com/${CANONICAL_RELEASE_REPOSITORY}/releases/download/${descriptor.release.tag}/${name}`;
}
function safeRelative(name: string): boolean {
  if (!name || name.startsWith('/') || name.startsWith('\\') || /^[A-Za-z]:/.test(name) || name.includes('\\')) return false;
  const withoutTrailingSlash = name.endsWith('/') ? name.slice(0, -1) : name;
  if (withoutTrailingSlash === '.') return true;
  const parts = withoutTrailingSlash.split('/');
  const relativeParts = parts[0] === '.' ? parts.slice(1) : parts;
  return relativeParts.length > 0 && relativeParts.every((part) => part !== '' && part !== '.' && part !== '..');
}
export function validateTarListing(listing: string): void {
  let count = 0; let expanded = 0;
  for (const line of listing.split(/\r?\n/)) {
    if (!line) continue;
    count += 1;
    // GNU tar verbose output: mode owner/group size date time name [-> target].
    const match = /^(\S)([rwxstST-]{9})\s+\S+\s+(\d+)\s+\S+\s+\S+\s+(.*)$/.exec(line);
    if (!match) throw new ReleaseUpdateWorkerError('Archive listing is malformed.');
    const [, kind, , sizeText, rawName] = match;
    const [name, link] = rawName.split(kind === 'l' ? ' -> ' : kind === 'h' ? ' link to ' : '\u0000', 2);
    if (!safeRelative(name) || !['-', 'd', 'l', 'h'].includes(kind) || /[sStT]/.test(match[2]) || (kind !== 'l' && (match[2][4] === 'w' || match[2][7] === 'w'))) throw new ReleaseUpdateWorkerError('Archive contains an unsafe entry.');
    if (kind === 'l' || kind === 'h') {
      if (!link || link.startsWith('/') || link.startsWith('\\') || /^[A-Za-z]:/.test(link)) {
        throw new ReleaseUpdateWorkerError('Archive contains an unsafe link.');
      }
      const resolved = kind === 'l'
        ? nodePath.posix.normalize(nodePath.posix.join(nodePath.posix.dirname(name), link))
        : nodePath.posix.normalize(link);
      if (!safeRelative(resolved)) throw new ReleaseUpdateWorkerError('Archive contains an escaping link.');
    }
    const size = Number(sizeText);
    if (!Number.isSafeInteger(size) || size < 0) throw new ReleaseUpdateWorkerError('Archive contains an invalid size.');
    expanded += size;
    if (count > MAX_ARCHIVE_ENTRIES || expanded > MAX_EXPANDED_BYTES) throw new ReleaseUpdateWorkerError('Archive exceeds safety limits.');
  }
  if (!count) throw new ReleaseUpdateWorkerError('Archive is empty.');
}
function parseChecksum(text: string, expectedName: string): string {
  const match = new RegExp(`^([a-f0-9]{64})\\s+\\*?${expectedName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm').exec(text.trim());
  if (!match || text.trim().split(/\r?\n/).length !== 1) throw new ReleaseUpdateWorkerError('Release checksum is malformed.');
  return match[1];
}
function isJsonObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function metadataFrom(text: string, version: string): CompatibilityMetadata {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new ReleaseUpdateWorkerError('Release metadata is invalid.'); }
  if (!isJsonObject(raw) || Object.keys(raw).length !== 4 || raw.schema !== 1 || raw.updaterProtocol !== 1) throw new ReleaseUpdateWorkerError('Release metadata is invalid.');
  const metadataVersion = parseStrictSemVer(raw.version);
  if (!metadataVersion || metadataVersion.version !== version) throw new ReleaseUpdateWorkerError('Release metadata version does not match descriptor.');
  const compatibility = validateCompatibilityMetadata(raw.compatibility);
  if (!compatibility) throw new ReleaseUpdateWorkerError('Release metadata compatibility is invalid.');
  return compatibility;
}

export class ReleaseUpdateWorker {
  private readonly home: string;
  private readonly root: string;
  private readonly fs: WorkerFileSystem;
  private readonly store: Pick<ReleaseUpdateStateStore, 'get' | 'transition' | 'persistRecoveryCheckpoint' | 'recordDownloadProgress'>;
  private readonly fetcher: NonNullable<ReleaseUpdateWorkerOptions['fetch']>;
  private readonly runProcess: WorkerProcess;
  private readonly health: (expectedVersion: string, serverPort: number, sourceBootId: string) => Promise<boolean>;
  private readonly requestTimeoutMs: number;
  private readonly onDurableBoundary: NonNullable<ReleaseUpdateWorkerOptions['onDurableBoundary']>;

  constructor(options: ReleaseUpdateWorkerOptions = {}) {
    this.home = options.home ?? process.env.HOME ?? '';
    if (!this.home || !nodePath.isAbsolute(this.home)) throw new ReleaseUpdateWorkerError('Owner home is unavailable.');
    this.root = nodePath.join(this.home, '.chatmux');
    this.fs = options.fs ?? fs;
    this.store = options.store ?? new ReleaseUpdateStateStore(nodePath.join(this.root, 'update'));
    this.fetcher = options.fetch ?? defaultFetch;
    this.runProcess = options.run ?? fixedRun;
    this.health = options.health ?? ((expectedVersion, serverPort, sourceBootId) => defaultHealth(expectedVersion, serverPort, sourceBootId, options.healthTiming));
    this.requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
    this.onDurableBoundary = options.onDurableBoundary ?? (() => undefined);
  }

  async run(jobId: string): Promise<void> {
    if (!isOpaqueUpdateJobId(jobId)) throw new ReleaseUpdateWorkerError('Invalid update job id.');
    const job = this.store.get(jobId);
    if (!job || job.phase !== 'queued') throw new ReleaseUpdateWorkerError('Update job is unavailable.');
    const descriptor = job.descriptor;
    const work = nodePath.join(this.root, 'update', `worker-${jobId}`);
    let prior: { path: string; version: string } | undefined;
    let cutOver = false;
    try {
      await this.safeManagedRoot();
      prior = await this.currentRelease();
      if (prior.version !== descriptor.sourceVersion) throw new ReleaseUpdateWorkerError('Current release does not match the update source version.');
      await this.safeMkdir(work);
      this.transition(jobId, 'downloading');
      const archive = nodePath.join(work, descriptor.release.archiveName);
      const archiveHash = await this.download(releaseAssetUrl(descriptor, descriptor.release.archiveName), archive, MAX_ARCHIVE_BYTES, this.progressReporter(jobId));
      const checksum = await this.downloadText(releaseAssetUrl(descriptor, descriptor.release.checksumName), nodePath.join(work, descriptor.release.checksumName), MAX_CHECKSUM_BYTES);
      this.transition(jobId, 'verifying');
      const expected = parseChecksum(checksum, descriptor.release.archiveName);
      if (expected !== descriptor.release.archiveSha256 || archiveHash !== expected) throw new ReleaseUpdateWorkerError('Release checksum does not match immutable descriptor.');
      const listing = await this.exec(TAR, ['--list', '--verbose', '--gzip', '--file', archive]);
      validateTarListing(listing.stdout);
      this.transition(jobId, 'staging');
      const stage = nodePath.join(work, 'stage');
      await this.safeMkdir(stage);
      await this.exec(TAR, ['--extract', '--gzip', '--file', archive, '--directory', stage, '--no-same-owner', '--no-same-permissions']);
      await this.validateStagedRelease(stage, descriptor, prior.version);
      const releases = nodePath.join(this.root, 'releases');
      const target = nodePath.join(releases, descriptor.release.version);
      await this.fs.mkdir(releases, { recursive: true, mode: 0o755 });
      try { await this.fs.lstat(target); throw new ReleaseUpdateWorkerError('Target release already exists.'); } catch (error) { if (!(error as { code?: string }).code || (error as { code?: string }).code !== 'ENOENT') throw error; }
      if ((await this.fs.stat(releases)).dev !== (await this.fs.stat(stage)).dev) throw new ReleaseUpdateWorkerError('Staging is not on the release filesystem.');
      await this.fs.rename(stage, target);
      this.store.persistRecoveryCheckpoint(jobId, {
        priorRelease: prior,
        targetRelease: { path: target, version: descriptor.release.version },
        cutoverState: 'prepared',
        rollbackState: 'not_started',
      });
      this.boundary('prepared');
      this.transition(jobId, 'cutting_over');
      await this.replaceCurrent(target, descriptor.release.version);
      cutOver = true;
      this.store.persistRecoveryCheckpoint(jobId, {
        priorRelease: prior,
        targetRelease: { path: target, version: descriptor.release.version },
        cutoverState: 'live_link_swapped',
        rollbackState: 'not_started',
      });
      this.boundary('live_link_swapped');
      this.transition(jobId, 'restarting');
      await this.exec(SYSTEMCTL, ['--user', 'restart', 'chatmux.service']);
      this.transition(jobId, 'verifying_health');
      if (!await this.health(descriptor.release.version, descriptor.serverPort, descriptor.sourceBootId)) throw new ReleaseUpdateWorkerError('Updated release failed exact-target health verification.');
      this.transition(jobId, 'succeeded');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Update failed.';
      if (error instanceof ReleaseUpdateWorkerCrash) throw error;
      if (error instanceof ManualCompatibilityError) return;
      if (!cutOver || !prior) { this.fail(jobId, 'failed', message); return; }
      await this.rollback(jobId, prior, descriptor, message);
    } finally { await this.fs.rm(work, { recursive: true, force: true }).catch(() => undefined); }
  }

  private transition(id: string, phase: ReleaseUpdatePhase, error?: string): void { this.store.transition(id, phase, error); }
  /** Throttled durable progress writes; display-only, so failures never abort the update. */
  private progressReporter(jobId: string): (downloadedBytes: number, totalBytes: number | undefined, done?: boolean) => void {
    let lastWriteMs = 0;
    return (downloadedBytes, totalBytes, done = false) => {
      const now = Date.now();
      if (!done && now - lastWriteMs < 1_000) return;
      lastWriteMs = now;
      try {
        this.store.recordDownloadProgress(jobId, { downloadedBytes, ...(totalBytes === undefined ? {} : { totalBytes }) });
      } catch { /* Progress is cosmetic; the phase machine stays authoritative. */ }
    };
  }
  private fail(id: string, phase: 'failed' | 'failed_rolled_back' | 'failed_rollback' | 'manual_required', message: string): void { this.transition(id, phase, message); }
  private async rollback(id: string, prior: { path: string; version: string }, descriptor: ImmutableUpdateJobDescriptor, failure: string): Promise<void> {
    this.transition(id, 'rolling_back', failure);
    const recovery = {
      priorRelease: prior,
      targetRelease: { path: nodePath.join(this.root, 'releases', descriptor.release.version), version: descriptor.release.version },
      cutoverState: 'live_link_swapped' as const,
      rollbackState: 'in_progress' as const,
    };
    this.store.persistRecoveryCheckpoint(id, recovery);
    this.boundary('rollback_in_progress');
    try {
      await this.replaceCurrent(prior.path, prior.version);
      this.store.persistRecoveryCheckpoint(id, recovery);
      this.boundary('rollback_link_restored');
      await this.exec(SYSTEMCTL, ['--user', 'restart', 'chatmux.service']);
      if (!await this.health(prior.version, descriptor.serverPort, descriptor.sourceBootId)) {
        this.store.persistRecoveryCheckpoint(id, { ...recovery, rollbackState: 'failed' });
        this.fail(id, 'failed_rollback', 'Rollback health verification failed.');
        this.boundary('terminalized');
        return;
      }
      await this.fs.rm(recovery.targetRelease.path, { recursive: true, force: true });
      this.store.persistRecoveryCheckpoint(id, { ...recovery, rollbackState: 'completed' });
      this.boundary('rollback_completed');
    } catch (error) {
      if (error instanceof ReleaseUpdateWorkerCrash) throw error;
      try { this.store.persistRecoveryCheckpoint(id, { ...recovery, rollbackState: 'failed' }); } catch { /* Preserve the original safe public failure. */ }
      this.fail(id, 'failed_rollback', 'Rollback could not be completed safely.');
      this.boundary('terminalized');
      return;
    }
    this.fail(id, 'failed_rolled_back', failure);
    this.boundary('terminalized');
  }
  private async download(url: string, destination: string, limit: number, onProgress?: (downloadedBytes: number, totalBytes: number | undefined, done?: boolean) => void): Promise<string> {
    const response = await this.request(url);
    if (response.status !== 200) throw new ReleaseUpdateWorkerError('Release download failed.');
    const declaredLength = Number.parseInt(response.headers.get('content-length') ?? '', 10);
    const totalBytes = Number.isSafeInteger(declaredLength) && declaredLength > 0 && declaredLength <= limit ? declaredLength : undefined;
    const hash = createHash('sha256'); let total = 0; let created = false;
    try {
      for await (const chunk of response.body) {
        total += chunk.byteLength;
        if (total > limit) throw new ReleaseUpdateWorkerError('Release download exceeds size limit.');
        hash.update(chunk);
        await this.fs.writeFile(destination, chunk, { mode: 0o600, flag: created ? 'a' : 'wx' });
        created = true;
        onProgress?.(total, totalBytes);
      }
      if (!created) await this.fs.writeFile(destination, '', { mode: 0o600, flag: 'wx' });
      // Final flush is unconditional so unsized downloads persist their true size.
      onProgress?.(total, totalBytes, true);
      return hash.digest('hex');
    } catch (error) {
      await this.fs.rm(destination, { recursive: false, force: true }).catch(() => undefined);
      throw error;
    }
  }
  private async downloadText(url: string, destination: string, limit: number): Promise<string> {
    await this.download(url, destination, limit);
    return String(await this.fs.readFile(destination, 'utf8'));
  }
  private async request(initial: string): Promise<HttpResponse> {
    let url = initial;
    for (let redirects = 0; redirects < 4; redirects += 1) {
      const parsed = new URL(url); if (parsed.protocol !== 'https:' || !RELEASE_HOSTS.has(parsed.hostname) || parsed.username || parsed.password || parsed.port) throw new ReleaseUpdateWorkerError('Release redirect is not allowed.');
      const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
      let response: HttpResponse;
      try { response = await this.fetcher(url, { signal: controller.signal, redirect: 'manual' }); } catch { clearTimeout(timer); throw new ReleaseUpdateWorkerError('Release download failed.'); }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        clearTimeout(timer);
        const location = response.headers.get('location'); if (!location) throw new ReleaseUpdateWorkerError('Release redirect is invalid.');
        url = new URL(location, url).toString();
        continue;
      }
      if (response.status !== 200) { clearTimeout(timer); return response; }
      return {
        status: response.status,
        headers: response.headers,
        body: (async function* (): AsyncGenerator<Uint8Array> {
          try { yield* response.body; } finally { clearTimeout(timer); }
        })(),
      };
    }
    throw new ReleaseUpdateWorkerError('Release redirect limit exceeded.');
  }
  private async currentRelease(): Promise<{ path: string; version: string }> {
    const current = nodePath.join(this.root, 'current'); const releases = nodePath.join(this.root, 'releases');
    const link = await this.fs.lstat(current); if (!link.isSymbolicLink()) throw new ReleaseUpdateWorkerError('Current release link is invalid.');
    const target = await this.fs.realpath(current); const base = await this.fs.realpath(releases);
    if (nodePath.dirname(target) !== base) throw new ReleaseUpdateWorkerError('Current release is not a direct child of releases.');
    const version = await this.releaseVersion(target);
    if (nodePath.basename(target) !== version) throw new ReleaseUpdateWorkerError('Current release directory does not match its version.');
    return { path: target, version };
  }
  private async validateStagedRelease(stage: string, descriptor: ImmutableUpdateJobDescriptor, priorVersion: string): Promise<void> {
    await this.checkTree(stage);
    await this.fs.access(nodePath.join(stage, 'scripts', 'chatmux-runtime.mjs'), fsConstants.R_OK);
    await this.fs.access(nodePath.join(stage, 'dist-server', 'server', 'release-update-worker.js'), fsConstants.R_OK);
    if (await this.releaseVersion(stage) !== descriptor.release.version) throw new ReleaseUpdateWorkerError('Embedded package version does not match descriptor.');
    const metadataText = await this.fs.readFile(nodePath.join(stage, 'release-update-metadata.json'), 'utf8');
    if (typeof metadataText !== 'string') throw new ReleaseUpdateWorkerError('Release metadata is invalid.');
    const metadata = metadataFrom(metadataText, descriptor.release.version);
    if (!metadata.database.rollbackCompatibleFrom.includes(priorVersion)) { this.fail(descriptor.id, 'manual_required', 'Release metadata does not permit rollback to current database version.'); throw new ManualCompatibilityError('Release metadata does not permit rollback to current database version.'); }
    if (JSON.stringify(metadata) !== JSON.stringify(descriptor.compatibility)) throw new ReleaseUpdateWorkerError('Release metadata does not match immutable descriptor.');
  }
  private async releaseVersion(directory: string): Promise<string> {
    const packageText = await this.fs.readFile(nodePath.join(directory, 'package.json'), 'utf8');
    if (typeof packageText !== 'string') throw new ReleaseUpdateWorkerError('Release package version is invalid.');
    let parsed: unknown;
    try { parsed = JSON.parse(packageText); } catch { throw new ReleaseUpdateWorkerError('Release package version is invalid.'); }
    if (!isJsonObject(parsed)) throw new ReleaseUpdateWorkerError('Release package version is invalid.');
    const version = parseStrictSemVer(parsed.version);
    if (!version) throw new ReleaseUpdateWorkerError('Release package version is invalid.');
    return version.version;
  }
  private async checkTree(directory: string): Promise<void> {
    let files = 0; let total = 0;
    const owner = typeof process.getuid === 'function' ? process.getuid() : undefined;
    const root = await this.fs.realpath(directory);
    const beneathRoot = (path: string): boolean => path === root || path.startsWith(`${root}${nodePath.sep}`);
    const visit = async (at: string): Promise<void> => {
      for (const item of await this.fs.readdir(at, { withFileTypes: true })) {
        const full = nodePath.join(at, item.name); const stat = await this.fs.lstat(full);
        if (item.isBlockDevice() || item.isCharacterDevice() || item.isFIFO() || item.isSocket() || (stat.mode & 0o6000) !== 0 || (!item.isSymbolicLink() && (stat.mode & 0o022) !== 0)) throw new ReleaseUpdateWorkerError('Extracted release contains unsafe filesystem entries.');
        if (owner !== undefined && stat.uid !== owner) throw new ReleaseUpdateWorkerError('Extracted release ownership is unsafe.');
        if (item.isSymbolicLink()) {
          let target: string; try { target = await this.fs.realpath(full); } catch { throw new ReleaseUpdateWorkerError('Extracted release contains a broken link.'); }
          if (!beneathRoot(target)) throw new ReleaseUpdateWorkerError('Extracted release contains an escaping link.');
          continue;
        }
        if (item.isDirectory()) await visit(full);
        else if (item.isFile()) {
          const target = await this.fs.realpath(full);
          if (!beneathRoot(target)) throw new ReleaseUpdateWorkerError('Extracted release contains an escaping hard link.');
          files += 1; total += stat.size;
          if (files > MAX_ARCHIVE_ENTRIES || total > MAX_EXPANDED_BYTES) throw new ReleaseUpdateWorkerError('Extracted release exceeds safety limits.');
        } else throw new ReleaseUpdateWorkerError('Extracted release contains an unsafe entry.');
      }
    };
    await visit(directory);
  }
  private async replaceCurrent(target: string, expectedVersion: string): Promise<void> {
    if (await this.releaseVersion(target) !== expectedVersion) throw new ReleaseUpdateWorkerError('Release target changed before cutover.');
    const link = nodePath.join(this.root, 'current'); const temporary = nodePath.join(this.root, `.current-${process.pid}-${Math.random().toString(36).slice(2)}`);
    await this.fs.symlink(target, temporary); try { await this.fs.rename(temporary, link); } catch (error) { await this.fs.rm(temporary, { recursive: false, force: true }); throw error; }
  }
  private async safeMkdir(directory: string): Promise<void> { await this.fs.mkdir(directory, { recursive: true, mode: 0o700 }); const stat = await this.fs.lstat(directory); if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700) throw new ReleaseUpdateWorkerError('Unsafe worker staging directory.'); }
  private async safeManagedRoot(): Promise<void> { await this.fs.mkdir(this.root, { recursive: true, mode: 0o700 }); const stat = await this.fs.lstat(this.root); const owner = typeof process.getuid === 'function' ? process.getuid() : undefined; if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700 || (owner !== undefined && stat.uid !== owner)) throw new ReleaseUpdateWorkerError('Unsafe managed release root.'); }
  private async exec(command: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> { const result = await this.runProcess(command, args, { env: validatedEnvironment() }); if (result.code !== 0) throw new ReleaseUpdateWorkerError('Required release command failed.'); return result; }
  private boundary(boundary: Parameters<NonNullable<ReleaseUpdateWorkerOptions['onDurableBoundary']>>[0]): void { this.onDurableBoundary(boundary); }
}

const PROCESS_ENV_ALLOWLIST = [
  'HOME',
  'LANG',
  'LC_ALL',
  'XDG_RUNTIME_DIR',
  'DBUS_SESSION_BUS_ADDRESS',
] as const;

function validatedEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    PROCESS_ENV_ALLOWLIST.flatMap((key) => {
      const value = process.env[key];
      return typeof value === 'string' && value.length > 0 && !value.includes('\0')
        ? [[key, value]]
        : [];
    }),
  );
}
async function defaultFetch(url: string, options: { signal: AbortSignal; redirect: 'manual' }): Promise<HttpResponse> { return fetch(url, options) as unknown as HttpResponse; }
export interface FixedRunLimits {
  timeoutMs: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
}

export function createFixedRun(limits: FixedRunLimits = {
  timeoutMs: PROCESS_TIMEOUT_MS,
  maxStdoutBytes: MAX_PROCESS_STDOUT_BYTES,
  maxStderrBytes: MAX_PROCESS_STDERR_BYTES,
}): WorkerProcess {
  return async (command, args, options): Promise<{ code: number; stdout: string; stderr: string }> => new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = nodeSpawn(command, [...args], { cwd: options?.cwd, env: options?.env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; let settled = false;
    const finish = (result?: { code: number; stdout: string; stderr: string }, error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(result!);
    };
    const terminate = (): void => { child.kill('SIGKILL'); finish(undefined, new ReleaseUpdateWorkerError('Required release command failed.')); };
    const timer = setTimeout(terminate, limits.timeoutMs);
    const append = (stream: 'stdout' | 'stderr', chunk: string): void => {
      const next = stream === 'stdout' ? Buffer.byteLength(stdout) + Buffer.byteLength(chunk) : Buffer.byteLength(stderr) + Buffer.byteLength(chunk);
      if (next > (stream === 'stdout' ? limits.maxStdoutBytes : limits.maxStderrBytes)) { terminate(); return; }
      if (stream === 'stdout') stdout += chunk; else stderr += chunk;
    };
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => append('stdout', chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => append('stderr', chunk));
    child.once('error', () => finish(undefined, new ReleaseUpdateWorkerError('Required release command failed.')));
    child.once('close', (code) => finish({ code: code ?? 1, stdout, stderr }));
  });
}
export const fixedRun = createFixedRun();
const sleep = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));
export async function pollHealth(expectedVersion: string, serverPort: number, sourceBootId: string, timing: { fetch?: typeof fetch; sleep?: (milliseconds: number) => Promise<void> } = {}): Promise<boolean> {
  if (!Number.isInteger(serverPort) || serverPort < 1 || serverPort > 65535 || !sourceBootId) return false;
  const healthFetch = timing.fetch ?? fetch;
  const healthSleep = timing.sleep ?? sleep;
  for (let attempt = 0; attempt < HEALTH_ATTEMPTS; attempt += 1) {
    try {
      const response = await healthFetch(`http://127.0.0.1:${serverPort}/health`, { signal: AbortSignal.timeout(HEALTH_REQUEST_TIMEOUT_MS) });
      if (response.status === 200) {
        const body = await response.json() as { product?: unknown; status?: unknown; version?: unknown; bootId?: unknown };
        if (body.product === 'chatmux' && body.status === 'ok' && body.version === expectedVersion && typeof body.bootId === 'string' && body.bootId.length > 0 && body.bootId !== sourceBootId) return true;
      }
    } catch { /* Startup, network, and malformed JSON failures are retried within the bounded window. */ }
    if (attempt + 1 < HEALTH_ATTEMPTS) await healthSleep(HEALTH_INTERVAL_MS);
  }
  return false;
}
async function defaultHealth(expectedVersion: string, serverPort: number, sourceBootId: string, timing?: { fetch?: typeof fetch; sleep?: (milliseconds: number) => Promise<void> }): Promise<boolean> { return pollHealth(expectedVersion, serverPort, sourceBootId, timing); }

const invokedPath = process.argv[1] ? nodePath.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  const [jobId, ...extra] = process.argv.slice(2);
  if (extra.length || !isOpaqueUpdateJobId(jobId)) { process.exitCode = 64; } else { new ReleaseUpdateWorker().run(jobId).catch(() => { process.exitCode = 1; }); }
}
