import { spawn, spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { isIP } from 'node:net';
import { randomBytes } from 'node:crypto';

import express, { type NextFunction, type Request, type Response as ExpressResponse, type Router } from 'express';

import { getTailscaleAccessInfo, type TailscaleAccessInfo } from './tailscale-access.js';
import { ReleaseUpdateStateError, ReleaseUpdateStateStore } from './release-update-state.js';
import { archiveNameForVersion, compareStrictSemVer, formatHealthProbeHost, hasCanonicalReleaseAssetSet, parseReleaseChecksumFile, parseStrictSemVer, resolveHealthProbeHost, validateCompatibilityMetadata, type CompatibilityMetadata, type ImmutableUpdateJobDescriptor, type ReleaseDescriptor } from './release-update-contract.js';

export type InstallMode = 'source' | 'release' | 'unknown';
export function detectInstallMode(appRoot: string, home: string = homedir()): InstallMode {
  const root = path.resolve(appRoot);
  const releasesRoot = path.resolve(home, '.chatmux', 'releases') + path.sep;
  if (root.startsWith(releasesRoot) || root === path.resolve(home, '.chatmux', 'current')) return 'release';
  return existsSync(path.join(root, '.git')) && existsSync(path.join(root, 'scripts', 'deploy.sh')) ? 'source' : 'unknown';
}
export function shellQuote(value: string): string { return `'${value.replaceAll("'", `'\\''`)}'`; }
export function buildSelfUpdateScript(appRoot: string, targetRevision: string, healthUrl: string, logPath: string): string {
  if (!GIT_REVISION_PATTERN.test(targetRevision)) throw new Error('Source update target revision is invalid.');
  return [
    `exec >>${shellQuote(logPath)} 2>&1`,
    'set -euo pipefail',
    'export PATH="$HOME/.cargo/bin:$HOME/.local/bin:$PATH"',
    'echo "[self-update] $(date -u +%FT%TZ) starting"',
    `cd ${shellQuote(appRoot)}`,
    'before="$(git rev-parse HEAD)"',
    'status_file="$(mktemp)" || { echo "[self-update] SOURCE_WORKTREE_STATUS_FAILED"; exit 1; }',
    'trap \'rm -f "$status_file"\' EXIT',
    'if ! git status --porcelain=v1 --untracked-files=all | head -c 4097 >"$status_file"; then',
    '  if [ -s "$status_file" ]; then',
    '    echo "[self-update] SOURCE_WORKTREE_DIRTY"',
    '  else',
    '    echo "[self-update] SOURCE_WORKTREE_STATUS_FAILED"',
    '  fi',
    '  exit 1',
    'fi',
    'if [ -s "$status_file" ]; then',
    '  echo "[self-update] SOURCE_WORKTREE_DIRTY"',
    '  exit 1',
    'fi',
    `git merge --ff-only ${shellQuote(targetRevision)}`,
    'after="$(git rev-parse HEAD)"',
    'if ! git diff --quiet "$before" "$after" -- package-lock.json; then npm ci; fi',
    `DEPLOY_HEALTH_URL=${shellQuote(healthUrl)} scripts/deploy.sh`,
    'echo "[self-update] $(date -u +%FT%TZ) finished"',
  ].join('\n');
}
export function buildSystemdRunArgs(unitName: string, script: string, environmentPath: string): string[] {
  return ['--user', '--collect', `--unit=${unitName}`, `--setenv=PATH=${environmentPath}`, '--setenv=DEPLOY_TRIGGER=self-update', 'bash', '-c', script];
}
export const SELF_UPDATE_STALE_MS = 15 * 60 * 1000;
const SOURCE_DISCOVERY_TIMEOUT_MS = 10_000;
const SOURCE_DISCOVERY_MAX_BYTES = 4_096;
const GIT_REVISION_PATTERN = /^[0-9a-f]{40,64}$/;

export type SourceUpdateRelation = 'same' | 'behind' | 'ahead' | 'diverged' | 'unknown';
export type SourceUpdateDescriptor = {
  available: boolean;
  currentRevision: string;
  targetRevision: string;
  targetVersion: string;
  relation: SourceUpdateRelation;
  blockedReason?: string;
};

class GitCommandError extends Error {
  constructor(message: string, readonly status: number | null) {
    super(message);
  }
}

class SourceUpdateError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) {
    super(message);
  }
}

function runGit(appRoot: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd: appRoot,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(stdout.trim());
    };
    const append = (current: string, chunk: Buffer, stream: 'stdout' | 'stderr'): string => {
      const next = current + chunk.toString('utf8');
      if (Buffer.byteLength(next) > SOURCE_DISCOVERY_MAX_BYTES) {
        child.kill('SIGKILL');
        finish(new Error(`Git update discovery ${stream} is too large.`));
      }
      return next;
    };
    child.stdout.on('data', (chunk: Buffer) => { stdout = append(stdout, chunk, 'stdout'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr = append(stderr, chunk, 'stderr'); });
    child.on('error', (error) => finish(error));
    child.on('close', (code) => {
      if (code === 0) finish();
      else finish(new GitCommandError(stderr.trim() || `git exited with ${code}`, code));
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error('Git update discovery timed out.'));
    }, SOURCE_DISCOVERY_TIMEOUT_MS);
  });
}

async function isGitAncestor(appRoot: string, ancestor: string, descendant: string): Promise<boolean> {
  try {
    await runGit(appRoot, ['merge-base', '--is-ancestor', ancestor, descendant]);
    return true;
  } catch (error) {
    if (error instanceof GitCommandError && error.status === 1) return false;
    throw error;
  }
}

async function sourceRelation(appRoot: string, currentRevision: string, targetRevision: string): Promise<SourceUpdateRelation> {
  if (currentRevision === targetRevision) return 'same';
  const currentIsAncestor = await isGitAncestor(appRoot, currentRevision, targetRevision);
  const targetIsAncestor = await isGitAncestor(appRoot, targetRevision, currentRevision);
  if (currentIsAncestor) return 'behind';
  if (targetIsAncestor) return 'ahead';
  return 'diverged';
}

function sourceDescriptor(currentRevision: string, targetRevision: string, relation: SourceUpdateRelation, blockedReason?: string): SourceUpdateDescriptor {
  return {
    available: currentRevision !== targetRevision && (relation === 'behind' || relation === 'unknown'),
    currentRevision,
    targetRevision,
    targetVersion: `main@${targetRevision.slice(0, 12)}`,
    relation,
    ...(blockedReason ? { blockedReason } : {}),
  };
}

/** Reads HEAD and origin/main without fetching or changing refs, the index, or the worktree. */
export async function discoverSourceUpdate(appRoot: string): Promise<SourceUpdateDescriptor> {
  const currentRevision = await runGit(appRoot, ['rev-parse', '--verify', 'HEAD']);
  const remoteOutput = await runGit(appRoot, ['ls-remote', '--exit-code', '--heads', 'origin', 'refs/heads/main']);
  const remoteMatch = /^([0-9a-f]{40,64})\s+refs\/heads\/main$/m.exec(remoteOutput);
  if (!GIT_REVISION_PATTERN.test(currentRevision) || !remoteMatch) {
    throw new Error('Git update discovery returned an invalid revision.');
  }
  const targetRevision = remoteMatch[1];
  try {
    return sourceDescriptor(currentRevision, targetRevision, await sourceRelation(appRoot, currentRevision, targetRevision));
  } catch {
    return sourceDescriptor(currentRevision, targetRevision, 'unknown', 'Source history relationship is unavailable without fetching.');
  }
}

async function inspectSourceClean(appRoot: string): Promise<void> {
  try {
    if (await runGit(appRoot, ['status', '--porcelain=v1', '--untracked-files=all'])) {
      throw new SourceUpdateError(409, 'SOURCE_WORKTREE_DIRTY', 'Source worktree must be clean before updating.');
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'Git update discovery stdout is too large.') {
      throw new SourceUpdateError(409, 'SOURCE_WORKTREE_DIRTY', 'Source worktree must be clean before updating.');
    }
    throw error;
  }
}

export async function prepareSourceUpdate(appRoot: string, inspectClean: (appRoot: string) => Promise<void> = inspectSourceClean): Promise<SourceUpdateDescriptor> {
  await inspectClean(appRoot);
  try {
    await runGit(appRoot, ['fetch', 'origin', 'main']);
    const currentRevision = await runGit(appRoot, ['rev-parse', '--verify', 'HEAD']);
    const targetRevision = await runGit(appRoot, ['rev-parse', '--verify', 'FETCH_HEAD']);
    if (!GIT_REVISION_PATTERN.test(currentRevision) || !GIT_REVISION_PATTERN.test(targetRevision)) {
      throw new Error('Git update preparation returned an invalid revision.');
    }
    const relation = await sourceRelation(appRoot, currentRevision, targetRevision);
    if (relation === 'behind') return sourceDescriptor(currentRevision, targetRevision, relation);
    if (relation === 'diverged') throw new SourceUpdateError(409, 'SOURCE_HISTORY_DIVERGED', 'Source history has diverged from origin/main.');
    throw new SourceUpdateError(409, 'SOURCE_UPDATE_NOT_AVAILABLE', 'No newer source revision is available.');
  } catch (error) {
    if (error instanceof SourceUpdateError) throw error;
    throw new SourceUpdateError(503, 'SOURCE_UPDATE_PREPARATION_FAILED', 'Source update preparation failed.');
  }
}
export type SelfUpdateState = { state: 'preparing'; token: string; unit: string; startedAt: number; operationId: string; initialBootId: string } | { state: 'in_flight'; unit: string; startedAt: number; operationId: string; initialBootId: string } | null;
export type SelfUpdatePlan = { action: 'reject'; statusCode: number; error: string } | { action: 'start' };
export function planSelfUpdate(args: { mode: InstallMode; inFlight: SelfUpdateState; now: number }): SelfUpdatePlan {
  if (args.mode === 'release') return { action: 'reject', statusCode: 409, error: 'Release updates use the verified release updater.' };
  if (args.mode !== 'source') return { action: 'reject', statusCode: 409, error: 'This install is not a git checkout with the update tooling.' };
  if (args.inFlight && args.now - args.inFlight.startedAt < SELF_UPDATE_STALE_MS) return { action: 'reject', statusCode: 429, error: 'An update is already in progress.' };
  return { action: 'start' };
}

function immediateLoopback(req: Request): boolean {
  const address = req.socket.remoteAddress?.replace(/^::ffff:/, '');
  return address === '127.0.0.1' || address === '::1';
}

type UpdateAuthUser = { tailscaleRole?: unknown; authSource?: unknown };

/** Only authentication middleware output and the immediate TCP peer participate in owner authority. */
export function canUpdate(req: Request, authMode: 'none' | 'password' | 'tailscale' = ((process.env.CHATMUX_AUTH === 'password' || process.env.CHATMUX_AUTH === 'tailscale') ? process.env.CHATMUX_AUTH : 'none') as 'none' | 'password' | 'tailscale'): boolean {
  const user = (req as Request & { user?: UpdateAuthUser }).user;
  if (authMode === 'password') return !!user;
  if (authMode === 'tailscale') return user?.tailscaleRole === 'owner' || (user?.authSource === 'local' && immediateLoopback(req));
  return immediateLoopback(req);
}

function trustedUpdateHost(host: string | undefined): boolean {
  if (!host || /\s/.test(host)) return false;
  const lower = host.toLowerCase();
  const match = /^\[([0-9a-f:.]+)\](?::(\d{1,5}))?$/.exec(lower);
  if (match) return isIP(match[1]) === 6 && (match[2] === undefined || (Number(match[2]) >= 1 && Number(match[2]) <= 65535)) && (match[1] === '::1' || /^(?:fc|fd)[0-9a-f:]*$/.test(match[1]) || /^fe[89ab][0-9a-f:]*$/.test(match[1]));
  const parts = /^([^:]+)(?::(\d{1,5}))?$/.exec(lower);
  if (!parts || (parts[2] !== undefined && (Number(parts[2]) < 1 || Number(parts[2]) > 65535))) return false;
  const name = parts[1];
  if (name === 'localhost' || /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.ts\.net$/.test(name)) return true;
  const octets = name.split('.');
  if (octets.length !== 4 || isIP(name) !== 4 || octets.some((part) => !/^\d{1,3}$/.test(part))) return false;
  const numbers = octets.map(Number);
  if (numbers.some((part) => part > 255)) return false;
  return numbers[0] === 127 || numbers[0] === 10 || (numbers[0] === 172 && numbers[1] >= 16 && numbers[1] <= 31) || (numbers[0] === 192 && numbers[1] === 168) || (numbers[0] === 169 && numbers[1] === 254) || (numbers[0] === 100 && numbers[1] >= 64 && numbers[1] <= 127);
}

/** This is mounted before CORS and body parsers. Rejection consumes no resolver/state/launcher work. */
export function exactUpdateRequestGuard(req: Request, res: ExpressResponse, next: NextFunction): void {
  if (req.method !== 'POST') return next();
  const origin = req.get('origin');
  const host = req.get('host');
  const expectedOrigin = host && trustedUpdateHost(host) ? `${req.protocol}://${host}` : null;
  const fetchSite = req.get('sec-fetch-site');
  const fetchDest = req.get('sec-fetch-dest');
  const length = req.get('content-length');
  const hasBody = (length !== undefined && length !== '0') || req.get('transfer-encoding') !== undefined || req.get('content-type') !== undefined;
  const hasQuery = req.originalUrl.includes('?');
  const framed = fetchDest === 'iframe' || fetchDest === 'frame' || fetchDest === 'nested-document';
  if (origin !== expectedOrigin || (fetchSite !== undefined && fetchSite !== 'same-origin') || req.get('x-chatmux-update-intent') !== 'start' || hasBody || hasQuery || framed) {
    res.status(400).json({ error: 'Invalid update request.' });
    return;
  }
  next();
}

type ReleaseNotes = { body: string | null; url: string | null };
type Discovery = { release: ReleaseDescriptor; compatibility: CompatibilityMetadata; notes: ReleaseNotes };

const RELEASE_NOTES_MAX_CHARS = 8_000;

/**
 * Display-only release notes. Kept OUT of ReleaseDescriptor on purpose: the
 * descriptor is a closed validated contract persisted into updater job state,
 * while notes are untrusted presentation text served to the UI as-is.
 */
export function releaseNotesFromLatest(latest: { body?: unknown; html_url?: unknown }, tag: string): ReleaseNotes {
  const body = typeof latest.body === 'string' && latest.body.trim()
    ? latest.body.trim().slice(0, RELEASE_NOTES_MAX_CHARS)
    : null;
  const url = typeof latest.html_url === 'string'
    && latest.html_url === `https://github.com/devswha/chatmux/releases/tag/${tag}`
    ? latest.html_url
    : null;
  return { body, url };
}
interface FetchResponse {
  ok: boolean;
  status: number;
  headers?: Headers;
  body?: ReadableStream<Uint8Array> | null;
  json(): Promise<unknown>;
  text(): Promise<string>;
}
type FetchLike = (url: string, init?: RequestInit) => Promise<FetchResponse>;
type DiscoveryFetch = { response: FetchResponse; timeout: Promise<never>; done: () => void };
const DISCOVERY_CACHE_MS = 60_000;
const DISCOVERY_TIMEOUT_MS = 10_000;
const DISCOVERY_MAX_BYTES = 1_000_000;
const CHECKSUM_REDIRECT_HOSTS = new Set(['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']);
const CHECKSUM_MAX_REDIRECTS = 3;
const DISCOVERY_USER_AGENT = 'ChatMux-release-updater';

function rejectOversize(response: FetchResponse): void {
  const length = response.headers?.get('content-length');
  if (length !== null && length !== undefined && (!/^\d+$/.test(length) || Number(length) > DISCOVERY_MAX_BYTES)) throw new Error('Release discovery response is too large.');
}

async function readBoundedText(response: FetchResponse): Promise<string> {
  rejectOversize(response);
  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > DISCOVERY_MAX_BYTES) throw new Error('Release discovery response is too large.');
    return text;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > DISCOVERY_MAX_BYTES) {
        await reader.cancel();
        throw new Error('Release discovery response is too large.');
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
}

async function readJson(fetchResult: DiscoveryFetch): Promise<unknown> {
  const { response } = fetchResult;
  try {
    if (!response.ok) throw new Error(`Release discovery failed with status ${response.status}.`);
    if (!response.body) {
      rejectOversize(response);
      return await Promise.race([response.json(), fetchResult.timeout]);
    }
    return JSON.parse(await Promise.race([readBoundedText(response), fetchResult.timeout]));
  } finally {
    fetchResult.done();
  }
}

async function readText(fetchResult: DiscoveryFetch): Promise<string> {
  const { response } = fetchResult;
  try {
    if (!response.ok) throw new Error(`Release discovery failed with status ${response.status}.`);
    return await Promise.race([readBoundedText(response), fetchResult.timeout]);
  } finally {
    fetchResult.done();
  }
}

async function discoveryFetch(fetcher: FetchLike, url: string, init: RequestInit = {}): Promise<DiscoveryFetch> {
  const controller = new AbortController();
  let rejectTimeout: ((reason?: unknown) => void) | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    rejectTimeout = reject;
  });
  const timeout = setTimeout(() => {
    controller.abort();
    rejectTimeout!(new Error('Release discovery timed out.'));
  }, DISCOVERY_TIMEOUT_MS);
  let done = false;
  const finish = () => {
    if (!done) {
      done = true;
      clearTimeout(timeout);
    }
  };
  try {
    const response = await Promise.race([fetcher(url, { ...init, redirect: 'manual', signal: controller.signal, headers: { accept: 'application/vnd.github+json', 'user-agent': DISCOVERY_USER_AGENT, ...init.headers } }), timedOut]);
    return { response, timeout: timedOut, done: finish };
  } catch (error) {
    finish();
    throw error;
  }
}

function isCanonicalChecksumAssetUrl(value: string, tag: string, checksumName: string): boolean {
  try {
    const url = new URL(value);
    return value.startsWith('https://github.com/') && url.protocol === 'https:' && url.hostname === 'github.com' && !url.port && !url.username && !url.password && !url.search && !url.hash && url.pathname === `/devswha/chatmux/releases/download/${tag}/${checksumName}`;
  } catch {
    return false;
  }
}

function checksumRedirectUrl(location: string, base: string): string | null {
  try {
    if (!location.startsWith('https://')) return null;
    const url = new URL(location, base);
    const authority = location.slice('https://'.length).split(/[/?#]/, 1)[0];
    if (authority !== url.hostname || url.protocol !== 'https:' || !CHECKSUM_REDIRECT_HOSTS.has(url.hostname) || url.port || url.username || url.password || url.hash) return null;
    return url.href;
  } catch {
    return null;
  }
}

async function downloadCanonicalChecksum(fetcher: FetchLike, checksumUrl: string): Promise<string> {
  const controller = new AbortController();
  let rejectTimeout: ((reason?: unknown) => void) | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => { rejectTimeout = reject; });
  const timeout = setTimeout(() => {
    controller.abort();
    rejectTimeout!(new Error('Release discovery timed out.'));
  }, DISCOVERY_TIMEOUT_MS);
  let done = false;
  const finish = () => {
    if (!done) {
      done = true;
      clearTimeout(timeout);
    }
  };
  try {
    let url = checksumUrl;
    const visited = new Set([url]);
    for (let redirects = 0; ; redirects += 1) {
      const response = await Promise.race([fetcher(url, { redirect: 'manual', signal: controller.signal, headers: { accept: 'application/vnd.github+json', 'user-agent': DISCOVERY_USER_AGENT } }), timedOut]);
      if (response.status < 300 || response.status >= 400) return await readText({ response, timeout: timedOut, done: finish });
      if (redirects >= CHECKSUM_MAX_REDIRECTS) throw new Error('Canonical release checksum redirect limit exceeded.');
      const location = response.headers?.get('location');
      const next = location ? checksumRedirectUrl(location, url) : null;
      if (!next) throw new Error('Canonical release checksum redirect is invalid.');
      if (visited.has(next)) throw new Error('Canonical release checksum redirect loop detected.');
      visited.add(next);
      url = next;
    }
  } catch (error) {
    finish();
    throw error;
  }
}

/** Server-owned canonical stable release resolution; callers cannot select repository, tag, or assets. */
export async function discoverCanonicalRelease(fetcher: FetchLike = fetch): Promise<Discovery> {
  const latest = await readJson(await discoveryFetch(fetcher, 'https://api.github.com/repos/devswha/chatmux/releases/latest')) as { tag_name?: unknown; published_at?: unknown; prerelease?: unknown; draft?: unknown; assets?: unknown; body?: unknown; html_url?: unknown };
  if (latest.prerelease || latest.draft || typeof latest.tag_name !== 'string' || !latest.tag_name.startsWith('v') || !parseStrictSemVer(latest.tag_name.slice(1)) || typeof latest.published_at !== 'string' || !Array.isArray(latest.assets)) throw new Error('Canonical stable release is invalid.');
  const version = latest.tag_name.slice(1); const archiveName = archiveNameForVersion(version)!; const checksumName = `${archiveName}.sha256`;
  if (latest.assets.some((asset) => !asset || typeof asset !== 'object' || typeof (asset as { name?: unknown }).name !== 'string' || typeof (asset as { browser_download_url?: unknown }).browser_download_url !== 'string')) throw new Error('Canonical release assets are incomplete.');
  const names = latest.assets.map((asset) => (asset as { name: string }).name);
  if (!hasCanonicalReleaseAssetSet(names, archiveName)) throw new Error('Canonical release assets are incomplete.');
  const assets = new Map(latest.assets.map((asset) => [((asset as { name: string }).name), ((asset as { browser_download_url: string }).browser_download_url)]));
  const checksumUrl = assets.get(checksumName)!;
  if (!isCanonicalChecksumAssetUrl(checksumUrl, latest.tag_name, checksumName)) throw new Error('Canonical release checksum asset is invalid.');
  const checksum = await downloadCanonicalChecksum(fetcher, checksumUrl);
  const archiveSha256 = parseReleaseChecksumFile(checksum, archiveName);
  if (archiveSha256 === null) throw new Error('Canonical release checksum is invalid.');
  const metadata = await readJson(await discoveryFetch(fetcher, `https://raw.githubusercontent.com/devswha/chatmux/${latest.tag_name}/packaging/release/update-compatibility.json`)) as { schema?: unknown; releases?: Record<string, unknown> };
  const compatibility = metadata.schema === 1 ? validateCompatibilityMetadata(metadata.releases?.[version]) : null;
  if (!compatibility) throw new Error('Canonical release compatibility metadata is invalid.');
  return { release: { repository: 'devswha/chatmux', tag: latest.tag_name, version, archiveName, checksumName, bootstrapName: 'install.sh', archiveSha256, publishedAt: latest.published_at }, compatibility, notes: releaseNotesFromLatest(latest, latest.tag_name) };
}

export interface SystemRouterOptions {
  appRoot: string; serverPort: number; bootId: string; runningVersion?: string; mode?: InstallMode; authMode?: 'none' | 'password' | 'tailscale';
  /** The HOST the server listens on; the update health probe must target it (wildcards map to loopback). */
  serverHost?: string;
  launch?: (unitName: string, script: string) => Promise<void>;
  launchRelease?: (unitName: string, workerPath: string, jobId: string) => Promise<void>;
  now?: () => number; home?: string; discoverRelease?: () => Promise<Discovery>; discoverSource?: () => Promise<SourceUpdateDescriptor>; inspectSourceClean?: () => Promise<void>; prepareSourceUpdate?: () => Promise<SourceUpdateDescriptor>; isReleaseUpdateUnitLive?: (unitName: string) => boolean; state?: Pick<ReleaseUpdateStateStore, 'initialize' | 'createIfNoActive' | 'publicStatus' | 'publicActiveStatus' | 'transition' | 'failIfInactive'>;
}
async function launchViaSystemdRun(unitName: string, script: string): Promise<void> { await new Promise<void>((resolve, reject) => { const child = spawn('systemd-run', buildSystemdRunArgs(unitName, script, process.env.PATH ?? ''), { stdio: ['ignore', 'ignore', 'pipe'] }); let stderr = ''; child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); }); child.on('error', (error) => reject(error)); child.on('close', (code) => code === 0 ? resolve() : reject(new Error(stderr.trim() || `systemd-run exited with ${code}`))); }); }
export function buildReleaseSystemdRunArgs(unitName: string, workerPath: string, jobId: string, home: string, serverPort: number, environmentPath: string, healthHost = '127.0.0.1'): string[] {
  // CHATMUX_HEALTH_HOST tells the worker where /health answers after the
  // restart: the server binds to HOST only, and the descriptor cannot carry the
  // address without breaking the prior release's state parser after a rollback.
  return ['--user', '--collect', `--unit=${unitName}`, `--setenv=HOME=${home}`, `--setenv=SERVER_PORT=${serverPort}`, `--setenv=CHATMUX_HEALTH_HOST=${resolveHealthProbeHost(healthHost)}`, `--setenv=PATH=${environmentPath}`, process.execPath, workerPath, jobId];
}
async function launchReleaseViaSystemdRun(unitName: string, workerPath: string, jobId: string, home: string, serverPort: number, healthHost: string): Promise<void> { await new Promise<void>((resolve, reject) => { const child = spawn('systemd-run', buildReleaseSystemdRunArgs(unitName, workerPath, jobId, home, serverPort, process.env.PATH ?? '', healthHost), { stdio: ['ignore', 'ignore', 'pipe'] }); let stderr = ''; child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); }); child.on('error', reject); child.on('close', (code) => code === 0 ? resolve() : reject(new Error(stderr.trim() || `systemd-run exited with ${code}`))); }); }
export type SystemdUnitLiveness = 'live' | 'inactive' | 'uncertain';
export function mapSystemctlIsActiveResult(result: { status: number | null; error?: unknown }): SystemdUnitLiveness {
  if (result.error || result.status === null) return 'uncertain';
  if (result.status === 0) return 'live';
  if (result.status === 3 || result.status === 4) return 'inactive';
  return 'uncertain';
}
export function isReleaseUpdateUnitLive(unitName: string): boolean {
  try {
    return mapSystemctlIsActiveResult(spawnSync('/usr/bin/systemctl', ['--user', 'is-active', unitName], { stdio: 'ignore' })) !== 'inactive';
  } catch { return true; }
}

function makesReleaseStateUnavailable(error: unknown): boolean {
  return error instanceof ReleaseUpdateStateError && /(?:corrupt|unsafe|ambiguous)/i.test(error.message);
}

/**
 * The worker refuses a target whose metadata does not name the running version
 * as rollback-compatible, but only after downloading and extracting it, and it
 * records that refusal as a permanent manual_required job. The router already
 * holds the same metadata, so it decides first and tells the UI why.
 */
export function rollbackBlockedReason(target: Discovery, runningVersion: string): string | undefined {
  if (target.compatibility.database.rollbackCompatibleFrom.includes(runningVersion)) return undefined;
  return `Release ${target.release.version} does not declare rollback compatibility from ${runningVersion}; reinstall with install.sh to move to it.`;
}

export function createSystemRouter(options: SystemRouterOptions): Router {
  const router = express.Router(); const mode = options.mode ?? detectInstallMode(options.appRoot); const now = options.now ?? Date.now; const home = options.home ?? homedir();
  const runningVersion = options.runningVersion;
  const releaseVersion = mode === 'release' ? parseStrictSemVer(runningVersion) : null;
  const releaseVersionUnavailable = mode === 'release' && !releaseVersion;
  const state = options.state ?? new ReleaseUpdateStateStore(path.join(home, '.chatmux', 'update'), { now });
  let releaseStateUnavailable = false;
  // A worker that died before cutover leaves a nonterminal job behind. Only the
  // updater restarts a release install, so this must run on every status read
  // and update request, not just once at router construction.
  const reconcileInactiveWorker = (): void => {
    const active = state.publicActiveStatus();
    if (active) state.failIfInactive(active.id, () => (options.isReleaseUpdateUnitLive ?? isReleaseUpdateUnitLive)(`chatmux-release-update-${active.id}`));
  };
  if (mode === 'release' && !releaseVersionUnavailable) {
    try {
      state.initialize();
      reconcileInactiveWorker();
    } catch (error) {
      if (makesReleaseStateUnavailable(error)) releaseStateUnavailable = true;
    }
  }
  const sourceLaunch = options.launch ?? launchViaSystemdRun; const releaseLaunch = options.launchRelease ?? ((unitName, workerPath, jobId) => launchReleaseViaSystemdRun(unitName, workerPath, jobId, home, options.serverPort, resolveHealthProbeHost(options.serverHost))); const discover = options.discoverRelease ?? (() => discoverCanonicalRelease()); const discoverSource = options.discoverSource ?? (() => discoverSourceUpdate(options.appRoot)); const inspectSource = options.inspectSourceClean ?? (() => inspectSourceClean(options.appRoot)); const prepareSource = options.prepareSourceUpdate ? async () => { await inspectSource(); return options.prepareSourceUpdate!(); } : () => prepareSourceUpdate(options.appRoot, async () => inspectSource());
  let inFlight: SelfUpdateState = null; let discoveryCache: { at: number; value: Discovery } | null = null; let sourceDiscoveryCache: { at: number; value: SourceUpdateDescriptor } | null = null; let accessCache: { at: number; info: TailscaleAccessInfo } | null = null;
  const owner = (req: Request) => canUpdate(req, options.authMode);
  const cachedDiscovery = async () => { if (!discoveryCache || now() - discoveryCache.at > DISCOVERY_CACHE_MS) discoveryCache = { at: now(), value: await discover() }; return discoveryCache.value; };
  const cachedSourceDiscovery = async () => { if (!sourceDiscoveryCache || now() - sourceDiscoveryCache.at > DISCOVERY_CACHE_MS) sourceDiscoveryCache = { at: now(), value: await discoverSource() }; return sourceDiscoveryCache.value; };
  router.get('/access-info', (_req, res) => { void (async () => { if (!accessCache || now() - accessCache.at > 30_000) accessCache = { at: now(), info: await getTailscaleAccessInfo(options.serverPort) }; res.json(accessCache.info); })().catch(() => res.json({ installed: false, running: false, dnsName: null, httpsUrls: [], suggestedCommand: null })); });
  router.get('/update/status', (req, res) => { void (async () => {
    const base = { mode, bootId: options.bootId, canUpdate: owner(req) };
    let source = null;
    if (mode === 'source') {
      try {
        const target = await cachedSourceDiscovery();
        source = inFlight && now() - inFlight.startedAt < SELF_UPDATE_STALE_MS
          ? { ...target, available: true, inFlight: true, operationId: inFlight.operationId, initialBootId: inFlight.initialBootId }
          : { ...target, inFlight: false };
      } catch {
        source = { available: null, inFlight: false };
      }
    }
    if (releaseVersionUnavailable) return res.json({ ...base, source, release: null, activeJob: null, updateUnavailable: 'Release updates require a valid installed version.' });
    if (mode !== 'release') return res.json({ ...base, source, release: null, activeJob: null });
    if (releaseStateUnavailable) return res.json({ ...base, source, release: null, activeJob: null, updateUnavailable: 'Release update state is unavailable. Repair the updater state before retrying.' });
    let activeJob;
    try { reconcileInactiveWorker(); activeJob = state.publicActiveStatus(); } catch (error) {
      if (makesReleaseStateUnavailable(error)) releaseStateUnavailable = true;
      return res.json({ ...base, source, release: null, activeJob: null, ...(releaseStateUnavailable ? { updateUnavailable: 'Release update state is unavailable. Repair the updater state before retrying.' } : {}) });
    }
    try {
      const target = await cachedDiscovery();
      const blockedReason = rollbackBlockedReason(target, releaseVersion!.version);
      const newer = compareStrictSemVer(target.release.version, releaseVersion!.version) === 1;
      return res.json({ ...base, source, release: { available: newer && blockedReason === undefined, targetVersion: target.release.version, notes: target.notes.body, url: target.notes.url, ...(newer && blockedReason !== undefined ? { blockedReason } : {}) }, activeJob });
    } catch {
      return res.json({ ...base, source, release: null, activeJob });
    }
  })().catch(() => { if (!res.headersSent) res.status(500).json({ error: 'Update status unavailable.' }); }); });
  router.get('/update/jobs/:jobId', (req, res) => { if (!owner(req)) return res.status(403).json({ error: 'Update access denied.' }); if (mode !== 'release' || releaseVersionUnavailable) return res.status(404).json({ error: 'Update job not found.' }); if (releaseStateUnavailable) return res.status(503).json({ error: 'Release updates are unavailable until updater state is repaired.' }); const job = state.publicStatus(req.params.jobId); return job ? res.json(job) : res.status(404).json({ error: 'Update job not found.' }); });
  router.post('/update', (req, res) => { void (async () => {
    if (!owner(req)) return res.status(403).json({ error: 'Update access denied.' });
    if (mode === 'source') {
      const plan = planSelfUpdate({ mode, inFlight, now: now() });
      if (plan.action === 'reject') {
        return res.status(plan.statusCode).json({ error: plan.error, ...(plan.statusCode === 429 ? { code: 'SOURCE_UPDATE_IN_PROGRESS' } : {}), mode });
      }
      const token = randomBytes(16).toString('base64url').slice(0, 22);
      const operationId = randomBytes(16).toString('base64url').slice(0, 22);
      const startedAt = now();
      inFlight = { state: 'preparing', token, unit: '', startedAt, operationId, initialBootId: options.bootId };
      try {
        const sourceTarget = await prepareSource();
        if (sourceTarget.relation === 'diverged') throw new SourceUpdateError(409, 'SOURCE_HISTORY_DIVERGED', 'Source history has diverged from origin/main.');
        if (sourceTarget.relation !== 'behind') throw new SourceUpdateError(409, 'SOURCE_UPDATE_NOT_AVAILABLE', 'No newer source revision is available.');
        const unit = `chatmux-self-update-${startedAt}`;
        await sourceLaunch(unit, buildSelfUpdateScript(options.appRoot, sourceTarget.targetRevision, `http://${formatHealthProbeHost(resolveHealthProbeHost(options.serverHost))}:${options.serverPort}/`, path.join(home, '.chatmux', 'self-update.log')));
        inFlight = { state: 'in_flight', unit, startedAt, operationId, initialBootId: options.bootId };
        return res.json({ started: true, mode, bootId: options.bootId, operationId, initialBootId: options.bootId, targetVersion: sourceTarget.targetVersion });
      } catch (error) {
        if (inFlight?.state === 'preparing' && inFlight.token === token) inFlight = null;
        if (error instanceof SourceUpdateError) return res.status(error.statusCode).json({ error: error.message, code: error.code, mode });
        return res.status(503).json({ error: 'Source update preparation failed.', code: 'SOURCE_UPDATE_PREPARATION_FAILED', mode });
      }
    }
    if (mode !== 'release') return res.status(409).json({ error: 'This install cannot self-update.', mode });
    if (releaseVersionUnavailable) return res.status(503).json({ error: 'Release updates require a valid installed version.', mode });
    if (releaseStateUnavailable) return res.status(503).json({ error: 'Release updates are unavailable until updater state is repaired.', mode });
    const target = await discover(); const comparison = compareStrictSemVer(target.release.version, releaseVersion!.version); if (comparison !== 1) return res.status(409).json({ error: 'No newer release is available.', mode });
    const blockedReason = rollbackBlockedReason(target, releaseVersion!.version); if (blockedReason !== undefined) return res.status(409).json({ error: blockedReason, code: 'RELEASE_ROLLBACK_INCOMPATIBLE', mode });
    try { reconcileInactiveWorker(); } catch (error) { if (makesReleaseStateUnavailable(error)) { releaseStateUnavailable = true; return res.status(503).json({ error: 'Release updates are unavailable until updater state is repaired.', mode }); } throw error; }
    const oldRelease = realpathSync(options.appRoot); const workerPath = path.join(oldRelease, 'dist-server', 'server', 'release-update-worker.js'); if (!existsSync(workerPath)) throw new Error('Release update worker is unavailable.');
    const id = randomBytes(16).toString('base64url').slice(0, 22); const descriptor: ImmutableUpdateJobDescriptor = { id, release: target.release, compatibility: target.compatibility, createdAt: now(), installMode: 'release', sourceVersion: releaseVersion!.version, sourceBootId: options.bootId, serverPort: options.serverPort };
    if (!state.createIfNoActive(descriptor)) return res.status(409).json({ error: 'An update is already in progress.', mode });
    try { await releaseLaunch(`chatmux-release-update-${id}`, workerPath, id); } catch (error) { state.transition(id, 'failed', 'Could not launch release updater.'); throw error; }
    return res.status(202).json({ started: true, jobId: id, mode, targetVersion: target.release.version });
  })().catch(() => { if (!res.headersSent) res.status(500).json({ error: 'Update failed to start.' }); }); });
  return router;
}
