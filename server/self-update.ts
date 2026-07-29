import { spawn, spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { isIP } from 'node:net';
import { randomBytes } from 'node:crypto';

import express, { type NextFunction, type Request, type Response as ExpressResponse, type Router } from 'express';

import { getTailscaleAccessInfo, type TailscaleAccessInfo } from './tailscale-access.js';
import { ReleaseUpdateStateError, ReleaseUpdateStateStore } from './release-update-state.js';
import { archiveNameForVersion, compareStrictSemVer, parseStrictSemVer, validateCompatibilityMetadata, type CompatibilityMetadata, type ImmutableUpdateJobDescriptor, type ReleaseDescriptor } from './release-update-contract.js';

export type InstallMode = 'source' | 'release' | 'unknown';
export function detectInstallMode(appRoot: string, home: string = homedir()): InstallMode {
  const root = path.resolve(appRoot);
  const releasesRoot = path.resolve(home, '.chatmux', 'releases') + path.sep;
  if (root.startsWith(releasesRoot) || root === path.resolve(home, '.chatmux', 'current')) return 'release';
  return existsSync(path.join(root, '.git')) && existsSync(path.join(root, 'scripts', 'deploy.sh')) ? 'source' : 'unknown';
}
export function shellQuote(value: string): string { return `'${value.replaceAll("'", `'\\''`)}'`; }
export function buildSelfUpdateScript(appRoot: string, healthUrl: string, logPath: string): string {
  return [`exec >>${shellQuote(logPath)} 2>&1`, 'set -euo pipefail', 'export PATH="$HOME/.cargo/bin:$HOME/.local/bin:$PATH"', 'echo "[self-update] $(date -u +%FT%TZ) starting"', `cd ${shellQuote(appRoot)}`, 'before="$(git rev-parse HEAD)"', 'git pull --ff-only origin main', 'after="$(git rev-parse HEAD)"', 'if ! git diff --quiet "$before" "$after" -- package-lock.json; then npm ci; fi', `DEPLOY_HEALTH_URL=${shellQuote(healthUrl)} scripts/deploy.sh`, 'echo "[self-update] $(date -u +%FT%TZ) finished"'].join('\n');
}
export function buildSystemdRunArgs(unitName: string, script: string, environmentPath: string): string[] {
  return ['--user', '--collect', `--unit=${unitName}`, `--setenv=PATH=${environmentPath}`, '--setenv=DEPLOY_TRIGGER=self-update', 'bash', '-c', script];
}
export const SELF_UPDATE_STALE_MS = 15 * 60 * 1000;
export type SelfUpdateState = { unit: string; startedAt: number; operationId?: string; initialBootId?: string } | null;
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

type Discovery = { release: ReleaseDescriptor; compatibility: CompatibilityMetadata };
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
  const latest = await readJson(await discoveryFetch(fetcher, 'https://api.github.com/repos/devswha/chatmux/releases/latest')) as { tag_name?: unknown; published_at?: unknown; prerelease?: unknown; draft?: unknown; assets?: unknown };
  if (latest.prerelease || latest.draft || typeof latest.tag_name !== 'string' || !latest.tag_name.startsWith('v') || !parseStrictSemVer(latest.tag_name.slice(1)) || typeof latest.published_at !== 'string' || !Array.isArray(latest.assets)) throw new Error('Canonical stable release is invalid.');
  const version = latest.tag_name.slice(1); const archiveName = archiveNameForVersion(version)!; const checksumName = `${archiveName}.sha256`;
  const expectedNames = [archiveName, checksumName, 'install.sh'];
  if (latest.assets.length !== expectedNames.length || latest.assets.some((asset) => !asset || typeof asset !== 'object' || typeof (asset as { name?: unknown }).name !== 'string' || typeof (asset as { browser_download_url?: unknown }).browser_download_url !== 'string')) throw new Error('Canonical release assets are incomplete.');
  const names = latest.assets.map((asset) => (asset as { name: string }).name);
  if (new Set(names).size !== names.length || names.some((name) => !expectedNames.includes(name))) throw new Error('Canonical release assets are incomplete.');
  const assets = new Map(latest.assets.map((asset) => [((asset as { name: string }).name), ((asset as { browser_download_url: string }).browser_download_url)]));
  const checksumUrl = assets.get(checksumName)!;
  if (!isCanonicalChecksumAssetUrl(checksumUrl, latest.tag_name, checksumName)) throw new Error('Canonical release checksum asset is invalid.');
  const checksum = await downloadCanonicalChecksum(fetcher, checksumUrl);
  const match = new RegExp(`^([a-f0-9]{64})  ${archiveName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm').exec(checksum);
  if (!match || checksum.trim().split(/\r?\n/).length !== 1) throw new Error('Canonical release checksum is invalid.');
  const metadata = await readJson(await discoveryFetch(fetcher, `https://raw.githubusercontent.com/devswha/chatmux/${latest.tag_name}/packaging/release/update-compatibility.json`)) as { schema?: unknown; releases?: Record<string, unknown> };
  const compatibility = metadata.schema === 1 ? validateCompatibilityMetadata(metadata.releases?.[version]) : null;
  if (!compatibility) throw new Error('Canonical release compatibility metadata is invalid.');
  return { release: { repository: 'devswha/chatmux', tag: latest.tag_name, version, archiveName, checksumName, bootstrapName: 'install.sh', archiveSha256: match[1], publishedAt: latest.published_at }, compatibility };
}

export interface SystemRouterOptions {
  appRoot: string; serverPort: number; bootId: string; runningVersion?: string; mode?: InstallMode; authMode?: 'none' | 'password' | 'tailscale';
  launch?: (unitName: string, script: string) => Promise<void>;
  launchRelease?: (unitName: string, workerPath: string, jobId: string) => Promise<void>;
  now?: () => number; home?: string; discoverRelease?: () => Promise<Discovery>; isReleaseUpdateUnitLive?: (unitName: string) => boolean; state?: Pick<ReleaseUpdateStateStore, 'initialize' | 'createIfNoActive' | 'publicStatus' | 'publicActiveStatus' | 'transition' | 'failIfInactive'>;
}
async function launchViaSystemdRun(unitName: string, script: string): Promise<void> { await new Promise<void>((resolve, reject) => { const child = spawn('systemd-run', buildSystemdRunArgs(unitName, script, process.env.PATH ?? ''), { stdio: ['ignore', 'ignore', 'pipe'] }); let stderr = ''; child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); }); child.on('error', (error) => reject(error)); child.on('close', (code) => code === 0 ? resolve() : reject(new Error(stderr.trim() || `systemd-run exited with ${code}`))); }); }
export function buildReleaseSystemdRunArgs(unitName: string, workerPath: string, jobId: string, home: string, serverPort: number, environmentPath: string): string[] {
  return ['--user', '--collect', `--unit=${unitName}`, `--setenv=HOME=${home}`, `--setenv=SERVER_PORT=${serverPort}`, `--setenv=PATH=${environmentPath}`, process.execPath, workerPath, jobId];
}
async function launchReleaseViaSystemdRun(unitName: string, workerPath: string, jobId: string, home: string, serverPort: number): Promise<void> { await new Promise<void>((resolve, reject) => { const child = spawn('systemd-run', buildReleaseSystemdRunArgs(unitName, workerPath, jobId, home, serverPort, process.env.PATH ?? ''), { stdio: ['ignore', 'ignore', 'pipe'] }); let stderr = ''; child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); }); child.on('error', reject); child.on('close', (code) => code === 0 ? resolve() : reject(new Error(stderr.trim() || `systemd-run exited with ${code}`))); }); }
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

export function createSystemRouter(options: SystemRouterOptions): Router {
  const router = express.Router(); const mode = options.mode ?? detectInstallMode(options.appRoot); const now = options.now ?? Date.now; const home = options.home ?? homedir();
  const runningVersion = options.runningVersion;
  const releaseVersion = mode === 'release' ? parseStrictSemVer(runningVersion) : null;
  const releaseVersionUnavailable = mode === 'release' && !releaseVersion;
  const state = options.state ?? new ReleaseUpdateStateStore(path.join(home, '.chatmux', 'update'), { now });
  let releaseStateUnavailable = false;
  if (mode === 'release' && !releaseVersionUnavailable) {
    try {
      state.initialize();
      const active = state.publicActiveStatus();
      if (active) state.failIfInactive(active.id, () => (options.isReleaseUpdateUnitLive ?? isReleaseUpdateUnitLive)(`chatmux-release-update-${active.id}`));
    } catch (error) {
      if (makesReleaseStateUnavailable(error)) releaseStateUnavailable = true;
    }
  }
  const sourceLaunch = options.launch ?? launchViaSystemdRun; const releaseLaunch = options.launchRelease ?? ((unitName, workerPath, jobId) => launchReleaseViaSystemdRun(unitName, workerPath, jobId, home, options.serverPort)); const discover = options.discoverRelease ?? (() => discoverCanonicalRelease());
  let inFlight: SelfUpdateState = null; let discoveryCache: { at: number; value: Discovery } | null = null; let accessCache: { at: number; info: TailscaleAccessInfo } | null = null;
  const owner = (req: Request) => canUpdate(req, options.authMode);
  const cachedDiscovery = async () => { if (!discoveryCache || now() - discoveryCache.at > DISCOVERY_CACHE_MS) discoveryCache = { at: now(), value: await discover() }; return discoveryCache.value; };
  router.get('/access-info', (_req, res) => { void (async () => { if (!accessCache || now() - accessCache.at > 30_000) accessCache = { at: now(), info: await getTailscaleAccessInfo(options.serverPort) }; res.json(accessCache.info); })().catch(() => res.json({ installed: false, running: false, dnsName: null, httpsUrls: [], suggestedCommand: null })); });
  router.get('/update/status', (req, res) => { void (async () => {
    const base = { mode, bootId: options.bootId, canUpdate: owner(req) };
    const source = mode === 'source' && inFlight && now() - inFlight.startedAt < SELF_UPDATE_STALE_MS
      ? { available: true, inFlight: true, operationId: inFlight.operationId, initialBootId: inFlight.initialBootId }
      : mode === 'source' ? { available: true, inFlight: false } : null;
    if (releaseVersionUnavailable) return res.json({ ...base, source, release: null, activeJob: null, updateUnavailable: 'Release updates require a valid installed version.' });
    if (mode !== 'release') return res.json({ ...base, source, release: null, activeJob: null });
    if (releaseStateUnavailable) return res.json({ ...base, source, release: null, activeJob: null, updateUnavailable: 'Release update state is unavailable. Repair the updater state before retrying.' });
    let activeJob;
    try { activeJob = state.publicActiveStatus(); } catch (error) {
      if (makesReleaseStateUnavailable(error)) releaseStateUnavailable = true;
      return res.json({ ...base, source, release: null, activeJob: null, ...(releaseStateUnavailable ? { updateUnavailable: 'Release update state is unavailable. Repair the updater state before retrying.' } : {}) });
    }
    try {
      const target = await cachedDiscovery();
      return res.json({ ...base, source, release: { available: compareStrictSemVer(target.release.version, releaseVersion!.version) === 1, targetVersion: target.release.version }, activeJob });
    } catch {
      return res.json({ ...base, source, release: null, activeJob });
    }
  })().catch(() => { if (!res.headersSent) res.status(500).json({ error: 'Update status unavailable.' }); }); });
  router.get('/update/jobs/:jobId', (req, res) => { if (!owner(req)) return res.status(403).json({ error: 'Update access denied.' }); if (mode !== 'release' || releaseVersionUnavailable) return res.status(404).json({ error: 'Update job not found.' }); if (releaseStateUnavailable) return res.status(503).json({ error: 'Release updates are unavailable until updater state is repaired.' }); const job = state.publicStatus(req.params.jobId); return job ? res.json(job) : res.status(404).json({ error: 'Update job not found.' }); });
  router.post('/update', (req, res) => { void (async () => { if (!owner(req)) return res.status(403).json({ error: 'Update access denied.' }); if (mode === 'source') { const plan = planSelfUpdate({ mode, inFlight, now: now() }); if (plan.action === 'reject') return res.status(plan.statusCode).json({ error: plan.error, mode }); const unit = `chatmux-self-update-${now()}`; const operationId = randomBytes(16).toString('base64url').slice(0, 22); await sourceLaunch(unit, buildSelfUpdateScript(options.appRoot, `http://127.0.0.1:${options.serverPort}/`, path.join(home, '.chatmux', 'self-update.log'))); inFlight = { unit, startedAt: now(), operationId, initialBootId: options.bootId }; return res.json({ started: true, mode, bootId: options.bootId, operationId, initialBootId: options.bootId }); }
    if (mode !== 'release') return res.status(409).json({ error: 'This install cannot self-update.', mode });
    if (releaseVersionUnavailable) return res.status(503).json({ error: 'Release updates require a valid installed version.', mode });
    if (releaseStateUnavailable) return res.status(503).json({ error: 'Release updates are unavailable until updater state is repaired.', mode });
    const target = await discover(); const comparison = compareStrictSemVer(target.release.version, releaseVersion!.version); if (comparison !== 1) return res.status(409).json({ error: 'No newer release is available.', mode });
    const oldRelease = realpathSync(options.appRoot); const workerPath = path.join(oldRelease, 'dist-server', 'server', 'release-update-worker.js'); if (!existsSync(workerPath)) throw new Error('Release update worker is unavailable.');
    const id = randomBytes(16).toString('base64url').slice(0, 22); const descriptor: ImmutableUpdateJobDescriptor = { id, release: target.release, compatibility: target.compatibility, createdAt: now(), installMode: 'release', sourceVersion: releaseVersion!.version, sourceBootId: options.bootId, serverPort: options.serverPort };
    if (!state.createIfNoActive(descriptor)) return res.status(409).json({ error: 'An update is already in progress.', mode });
    try { await releaseLaunch(`chatmux-release-update-${id}`, workerPath, id); } catch (error) { state.transition(id, 'failed', 'Could not launch release updater.'); throw error; }
    return res.status(202).json({ started: true, jobId: id, mode, targetVersion: target.release.version });
  })().catch(() => { if (!res.headersSent) res.status(500).json({ error: 'Update failed to start.' }); }); });
  return router;
}
