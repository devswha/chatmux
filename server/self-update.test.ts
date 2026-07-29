import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import {
  buildSelfUpdateScript,
  buildSystemdRunArgs,
  detectInstallMode,
  planSelfUpdate,
  SELF_UPDATE_STALE_MS,
  shellQuote,
  canUpdate,
  discoverCanonicalRelease,
  discoverSourceUpdate,
  createSystemRouter,
  exactUpdateRequestGuard,
  mapSystemctlIsActiveResult,
} from './self-update.js';
import { ReleaseUpdateStateStore } from './release-update-state.js';
import type { ImmutableUpdateJobDescriptor } from './release-update-contract.js';

function tempRoot(): string {
  return mkdtempSync(path.join(tmpdir(), 'self-update-'));
}
function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_AUTHOR_NAME: 'ChatMux Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'ChatMux Test',
    },
  }).trim();
}
function releaseJob(index: number): ImmutableUpdateJobDescriptor {
  const id = index.toString(36).padStart(22, '0');
  const version = `1.0.${index}`;
  const archiveName = `chatmux-server-${version}-linux-x64-node22.tar.gz`;
  return {
    id, createdAt: 1, installMode: 'release', sourceVersion: '1.0.0', sourceBootId: 'boot', serverPort: 3000,
    release: { repository: 'devswha/chatmux', tag: `v${version}`, version, archiveName, checksumName: `${archiveName}.sha256`, bootstrapName: 'install.sh', archiveSha256: 'a'.repeat(64), publishedAt: '2026-01-01T00:00:00.000Z' },
    compatibility: { database: { rollbackCompatibleFrom: [] } },
  };
}

test('detectInstallMode: git checkout with deploy tooling is source', () => {
  const root = tempRoot();
  mkdirSync(path.join(root, '.git'));
  mkdirSync(path.join(root, 'scripts'));
  writeFileSync(path.join(root, 'scripts', 'deploy.sh'), '#!/usr/bin/env bash\n');
  assert.equal(detectInstallMode(root, tempRoot()), 'source');
});

test('source discovery reports only a different origin/main revision without mutating the checkout', async () => {
  const root = tempRoot();
  const remote = path.join(root, 'remote.git');
  const seed = path.join(root, 'seed');
  const checkout = path.join(root, 'checkout');
  mkdirSync(seed);
  git(root, ['init', '--bare', remote]);
  git(seed, ['init', '--initial-branch=main']);
  writeFileSync(path.join(seed, 'package.json'), '{"version":"1.0.0"}\n');
  git(seed, ['add', 'package.json']);
  git(seed, ['commit', '-m', 'initial']);
  git(seed, ['remote', 'add', 'origin', remote]);
  git(seed, ['push', '-u', 'origin', 'main']);
  git(root, ['clone', '--branch', 'main', remote, checkout]);

  const current = await discoverSourceUpdate(checkout);
  assert.equal(current.available, false);
  assert.equal(current.currentRevision, current.targetRevision);

  const checkoutHead = git(checkout, ['rev-parse', 'HEAD']);
  writeFileSync(path.join(seed, 'package.json'), '{"version":"1.1.0"}\n');
  git(seed, ['add', 'package.json']);
  git(seed, ['commit', '-m', 'next']);
  git(seed, ['push', 'origin', 'main']);

  const update = await discoverSourceUpdate(checkout);
  assert.equal(update.available, true);
  assert.equal(update.currentRevision, checkoutHead);
  assert.notEqual(update.targetRevision, checkoutHead);
  assert.equal(update.targetVersion, `main@${update.targetRevision.slice(0, 12)}`);
  assert.equal(git(checkout, ['rev-parse', 'HEAD']), checkoutHead);
  assert.equal(git(checkout, ['status', '--porcelain']), '');
});

test('detectInstallMode: an unpacked release under ~/.chatmux/releases is release', () => {
  const home = tempRoot();
  const releaseRoot = path.join(home, '.chatmux', 'releases', '1.0.0');
  mkdirSync(releaseRoot, { recursive: true });
  // Even with git/deploy.sh present, the release location wins — the artifact
  // contract (checksum-verified cutover) must not be bypassed by one click.
  mkdirSync(path.join(releaseRoot, '.git'));
  mkdirSync(path.join(releaseRoot, 'scripts'));
  writeFileSync(path.join(releaseRoot, 'scripts', 'deploy.sh'), '');
  assert.equal(detectInstallMode(releaseRoot, home), 'release');
});

test('detectInstallMode: a bare directory without tooling is unknown', () => {
  const root = tempRoot();
  assert.equal(detectInstallMode(root, tempRoot()), 'unknown');
  const gitOnly = tempRoot();
  mkdirSync(path.join(gitOnly, '.git'));
  assert.equal(detectInstallMode(gitOnly, tempRoot()), 'unknown', 'a checkout without deploy.sh cannot self-update');
});

test('planSelfUpdate: only source mode may start; release and unknown fail closed', () => {
  const now = 1_000_000;
  assert.deepEqual(planSelfUpdate({ mode: 'source', inFlight: null, now }), { action: 'start' });

  const release = planSelfUpdate({ mode: 'release', inFlight: null, now });
  assert.equal(release.action, 'reject');
  assert.equal(release.action === 'reject' && release.statusCode, 409);

  const unknown = planSelfUpdate({ mode: 'unknown', inFlight: null, now });
  assert.equal(unknown.action, 'reject');
  assert.equal(unknown.action === 'reject' && unknown.statusCode, 409);
});

test('planSelfUpdate: single-flight rejects a concurrent start but a stale marker expires', () => {
  const startedAt = 1_000_000;
  const running = planSelfUpdate({ mode: 'source', inFlight: { unit: 'u', startedAt }, now: startedAt + 60_000 });
  assert.equal(running.action, 'reject');
  assert.equal(running.action === 'reject' && running.statusCode, 429);

  const afterStale = planSelfUpdate({
    mode: 'source',
    inFlight: { unit: 'u', startedAt },
    now: startedAt + SELF_UPDATE_STALE_MS + 1,
  });
  assert.deepEqual(afterStale, { action: 'start' }, 'a crashed updater must not wedge the button forever');
});

test('buildSelfUpdateScript: ff-only pull, conditional npm ci, deploy.sh with the health url', () => {
  const script = buildSelfUpdateScript('/srv/app dir', 'http://127.0.0.1:3021/', '/home/u/.chatmux/self-update.log');
  assert.ok(script.includes("cd '/srv/app dir'"), 'app root is shell-quoted');
  assert.ok(script.includes('git pull --ff-only origin main'), 'never merges or rebases on its own');
  assert.ok(/if ! git diff --quiet .* -- package-lock\.json; then npm ci; fi/.test(script),
    'node_modules is only reinstalled when the pull changed dependencies');
  assert.ok(script.includes("DEPLOY_HEALTH_URL='http://127.0.0.1:3021/' scripts/deploy.sh"),
    'hands over to the verified deploy machinery (build → restart → health → rollback)');
  assert.ok(script.startsWith("exec >>'/home/u/.chatmux/self-update.log' 2>&1"), 'output lands in the log file');
  assert.ok(script.includes('set -euo pipefail'), 'any failing step stops the update');
  assert.ok(script.includes('export PATH="$HOME/.cargo/bin:$HOME/.local/bin:$PATH"'),
    'the transient unit must reach cargo for the native-core build (실측 ENOENT)');
});

test('buildSystemdRunArgs: detached transient unit with the caller PATH', () => {
  const args = buildSystemdRunArgs('chatmux-self-update-1', 'echo hi', '/usr/bin:/bin');
  assert.deepEqual(args.slice(0, 3), ['--user', '--collect', '--unit=chatmux-self-update-1']);
  assert.ok(args.includes('--setenv=PATH=/usr/bin:/bin'), 'nvm-provided node must be reachable in the unit');
  assert.deepEqual(args.slice(-3), ['bash', '-c', 'echo hi']);
});
test('systemctl is-active mapping proves only statuses 3 and 4 inactive', () => {
  assert.equal(mapSystemctlIsActiveResult({ status: 0 }), 'live');
  assert.equal(mapSystemctlIsActiveResult({ status: 3 }), 'inactive');
  assert.equal(mapSystemctlIsActiveResult({ status: 4 }), 'inactive');
  assert.equal(mapSystemctlIsActiveResult({ status: 1 }), 'uncertain');
  assert.equal(mapSystemctlIsActiveResult({ status: null }), 'uncertain');
  assert.equal(mapSystemctlIsActiveResult({ status: 3, error: new Error('unavailable') }), 'uncertain');
});

test('owner authority accepts only owners or explicitly local loopback identities in Tailscale mode', () => {
  const request = (user: unknown, address: string) => ({
    user, socket: { remoteAddress: address }, headers: { 'x-forwarded-for': '127.0.0.1' }
  }) as any;
  assert.equal(canUpdate(request({ tailscaleRole: 'owner' }, '100.64.0.1'), 'tailscale'), true);
  assert.equal(canUpdate(request({ tailscaleRole: 'user' }, '100.64.0.1'), 'tailscale'), false);
  assert.equal(canUpdate(request({ tailscaleRole: 'user' }, '127.0.0.1'), 'tailscale'), false);
  assert.equal(canUpdate(request({ authSource: 'local' }, '127.0.0.1'), 'tailscale'), true);
  assert.equal(canUpdate(request({ authSource: 'local' }, '100.64.0.1'), 'tailscale'), false);
  assert.equal(canUpdate(request({}, '100.64.0.1'), 'none'), false);
  assert.equal(canUpdate(request(undefined, '127.0.0.1'), 'none'), true);
});
test('update request guard requires same-origin trusted literal hosts and bodyless framing', () => {
  const guard = (headers: Record<string, string | undefined>, originalUrl = '/') => {
    let status = 0;
    let next = false;
    exactUpdateRequestGuard({
      method: 'POST', protocol: 'http', originalUrl,
      get: (name: string) => headers[name.toLowerCase()],
    } as any, {
      status: (value: number) => {
        status = value;
        return { json: () => undefined };
      },
    } as any, () => { next = true; });
    return { next, status };
  };
  assert.deepEqual(guard({ host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000', 'x-chatmux-update-intent': 'start' }), { next: true, status: 0 });
  assert.deepEqual(guard({ host: 'device.tailnet.ts.net', origin: 'http://device.tailnet.ts.net', 'x-chatmux-update-intent': 'start' }), { next: true, status: 0 });
  assert.equal(guard({ host: 'rebind.example', origin: 'http://rebind.example', 'x-chatmux-update-intent': 'start' }).status, 400);
  assert.equal(guard({ host: 'localhost:3000', origin: 'http://localhost:3000', 'x-chatmux-update-intent': 'start', 'content-length': '1' }).status, 400);
  assert.equal(guard({ host: 'localhost:3000', origin: 'https://localhost:3000', 'x-chatmux-update-intent': 'start' }).status, 400);
});
test('mounted update boundary rejects malformed POSTs before router effects and preserves source contracts', async () => {
  let launches = 0;
  let discoveries = 0;
  let sourceDiscoveries = 0;
  const sourceTarget = {
    available: true,
    currentRevision: '1'.repeat(40),
    targetRevision: '2'.repeat(40),
    targetVersion: `main@${'2'.repeat(12)}`,
  };
  const app = express();
  app.use(exactUpdateRequestGuard);
  app.use(express.json());
  app.use(createSystemRouter({
    appRoot: tempRoot(), home: tempRoot(), serverPort: 3000, bootId: 'boot', mode: 'source',
    launch: async () => { launches += 1; },
    discoverRelease: async () => { discoveries += 1; return { release: releaseJob(9).release, compatibility: releaseJob(9).compatibility }; },
    discoverSource: async () => { sourceDiscoveries += 1; return sourceTarget; },
  }));
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const updateHeaders = { origin: baseUrl, 'x-chatmux-update-intent': 'start' };
  try {
    for (const init of [
      { headers: { ...updateHeaders, 'content-type': 'application/json' }, body: '{}' },
      { headers: { ...updateHeaders, 'x-chatmux-update-intent': 'wrong' } },
      { headers: { ...updateHeaders, origin: 'http://attacker.example' } },
      { headers: { ...updateHeaders, 'sec-fetch-site': 'cross-site' } },
    ]) {
      const response = await fetch(`${baseUrl}/update`, { method: 'POST', ...init });
      assert.equal(response.status, 400, JSON.stringify(init));
    }
    const hostileHostStatus = await new Promise<number>((resolve, reject) => {
      const request = httpRequest({
        hostname: '127.0.0.1',
        port: address.port,
        path: '/update',
        method: 'POST',
        headers: { ...updateHeaders, host: 'attacker.example' },
      }, (response) => {
        response.resume();
        response.once('end', () => resolve(response.statusCode ?? 0));
      });
      request.once('error', reject);
      request.end();
    });
    assert.equal(hostileHostStatus, 400);
    assert.equal((await fetch(`${baseUrl}/update?ignored=1`, { method: 'POST', headers: updateHeaders })).status, 400);
    assert.equal(launches, 0);
    assert.equal(discoveries, 0);
    assert.equal(sourceDiscoveries, 0);
    const started = await fetch(`${baseUrl}/update`, { method: 'POST', headers: updateHeaders });
    assert.equal(started.status, 200);
    const start = await started.json() as { operationId: string; initialBootId: string; targetVersion: string };
    assert.match(start.operationId, /^[A-Za-z0-9_-]{22}$/);
    assert.equal(start.initialBootId, 'boot');
    assert.equal(start.targetVersion, sourceTarget.targetVersion);
    assert.equal(launches, 1);
    assert.equal(discoveries, 0);
    assert.equal(sourceDiscoveries, 1);
    assert.equal((await fetch(`${baseUrl}/update`, { method: 'POST', headers: updateHeaders })).status, 429);
    const status = await (await fetch(`${baseUrl}/update/status`)).json() as { source: { operationId: string; initialBootId: string; available: boolean; targetVersion: string } };
    assert.equal(status.source.operationId, start.operationId);
    assert.equal(status.source.initialBootId, 'boot');
    assert.equal(status.source.available, true);
    assert.equal(status.source.targetVersion, sourceTarget.targetVersion);
    assert.equal(sourceDiscoveries, 2);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('source status and launch reject an unchanged origin/main revision', async () => {
  let launches = 0;
  const revision = '3'.repeat(40);
  const sourceTarget = {
    available: false,
    currentRevision: revision,
    targetRevision: revision,
    targetVersion: `main@${revision.slice(0, 12)}`,
  };
  const app = express();
  app.use(exactUpdateRequestGuard);
  app.use(createSystemRouter({
    appRoot: tempRoot(),
    home: tempRoot(),
    serverPort: 3000,
    bootId: 'boot',
    mode: 'source',
    launch: async () => { launches += 1; },
    discoverSource: async () => sourceTarget,
  }));
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const status = await (await fetch(`${baseUrl}/update/status`)).json() as { source: typeof sourceTarget };
    assert.deepEqual(status.source, { ...sourceTarget, inFlight: false });

    const response = await fetch(`${baseUrl}/update`, {
      method: 'POST',
      headers: { origin: baseUrl, 'x-chatmux-update-intent': 'start' },
    });
    assert.equal(response.status, 409);
    assert.equal(launches, 0);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('mounted release job route denies non-owners', async () => {
  const home = tempRoot();
  const state = new ReleaseUpdateStateStore(path.join(home, '.chatmux', 'update'));
  const app = express();
  app.use(exactUpdateRequestGuard);
  app.use(createSystemRouter({ appRoot: home, home, serverPort: 3000, bootId: 'boot', runningVersion: '1.0.0', mode: 'release', authMode: 'password', state }));
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/update/jobs/not-a-job`);
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: 'Update access denied.' });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('mounted release update exposes only sanitized job state and fixed launcher inputs', async () => {
  const home = tempRoot();
  const workerPath = path.join(home, 'dist-server', 'server', 'release-update-worker.js');
  mkdirSync(path.dirname(workerPath), { recursive: true });
  writeFileSync(workerPath, '');
  const state = new ReleaseUpdateStateStore(path.join(home, '.chatmux', 'update'), { now: () => 1 });
  const launches: Array<[string, string, string]> = [];
  const app = express();
  app.use((req, _res, next) => { (req as any).user = {}; next(); });
  app.use(exactUpdateRequestGuard);
  app.use(createSystemRouter({
    appRoot: home, home, serverPort: 3000, bootId: 'boot', runningVersion: '1.0.0', mode: 'release', authMode: 'password', state, now: () => 1,
    discoverRelease: async () => ({ release: releaseJob(9).release, compatibility: releaseJob(9).compatibility }),
    launchRelease: async (unit, receivedWorkerPath, id) => { launches.push([unit, receivedWorkerPath, id]); },
  }));
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const updateHeaders = { origin: baseUrl, 'x-chatmux-update-intent': 'start' };
  try {
    const started = await fetch(`${baseUrl}/update`, { method: 'POST', headers: updateHeaders });
    assert.equal(started.status, 202);
    const start = await started.json() as { jobId: string };
    assert.match(start.jobId, /^[A-Za-z0-9_-]{22}$/);
    assert.deepEqual(launches, [[`chatmux-release-update-${start.jobId}`, workerPath, start.jobId]]);

    const known = await fetch(`${baseUrl}/update/jobs/${start.jobId}`);
    assert.equal(known.status, 200);
    assert.deepEqual(await known.json(), {
      id: start.jobId, phase: 'queued', createdAt: 1, updatedAt: 1, targetVersion: '1.0.9',
    });

    const unknown = await fetch(`${baseUrl}/update/jobs/${'x'.repeat(22)}`);
    const expired = await fetch(`${baseUrl}/update/jobs/${'y'.repeat(22)}`);
    assert.equal(unknown.status, 404);
    assert.equal(expired.status, 404);
    assert.deepEqual(await unknown.json(), await expired.json());
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('release updates fail closed without a strict installed version before state, discovery, or launch', async () => {
  let stateCalls = 0;
  let discoveries = 0;
  let launches = 0;
  const state = {
    initialize: () => { stateCalls += 1; },
    createIfNoActive: () => { stateCalls += 1; return null; },
    publicStatus: () => { stateCalls += 1; return null; },
    publicActiveStatus: () => { stateCalls += 1; return null; },
    transition: () => { stateCalls += 1; return undefined as never; },
    failIfInactive: () => { stateCalls += 1; return null; },
  };
  const app = express();
  app.use(exactUpdateRequestGuard);
  app.use(createSystemRouter({
    appRoot: tempRoot(), home: tempRoot(), serverPort: 3000, bootId: 'boot', mode: 'release', state,
    discoverRelease: async () => { discoveries += 1; return { release: releaseJob(9).release, compatibility: releaseJob(9).compatibility }; },
    launchRelease: async () => { launches += 1; },
  }));
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const status = await (await fetch(`${baseUrl}/update/status`)).json() as { release: unknown; updateUnavailable: string };
    assert.equal(status.release, null);
    assert.match(status.updateUnavailable, /valid installed version/i);
    const started = await fetch(`${baseUrl}/update`, { method: 'POST', headers: { origin: baseUrl, 'x-chatmux-update-intent': 'start' } });
    assert.equal(started.status, 503);
    assert.equal(stateCalls, 0);
    assert.equal(discoveries, 0);
    assert.equal(launches, 0);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
test('canonical release discovery accepts only exact three-asset stable contract', async () => {
  const version = '1.2.3';
  const archive = `chatmux-server-${version}-linux-x64-node22.tar.gz`;
  const checksum = 'a'.repeat(64);
  const fetcher = async (url: string) => ({
    ok: true,
    json: async () => url.includes('/releases/latest')
      ? { tag_name: `v${version}`, published_at: '2026-01-02T03:04:05.000Z', assets: [
        { name: archive, browser_download_url: `https://github.com/devswha/chatmux/releases/download/v${version}/${archive}` },
        { name: `${archive}.sha256`, browser_download_url: `https://github.com/devswha/chatmux/releases/download/v${version}/${archive}.sha256` },
        { name: 'install.sh', browser_download_url: `https://github.com/devswha/chatmux/releases/download/v${version}/install.sh` }
      ] }
      : { schema: 1, releases: { [version]: { database: { rollbackCompatibleFrom: ['1.2.2'] } } } },
    text: async () => `${checksum}  ${archive}\n`,
    status: 200,
    headers: new Headers(),
  }) as any;
  const release = await discoverCanonicalRelease(fetcher);
  assert.equal(release.release.archiveName, archive);
  assert.deepEqual(release.compatibility.database.rollbackCompatibleFrom, ['1.2.2']);
});
function canonicalDiscoveryFetcher(checksumResponse: (url: string) => any, checksumUrl?: string, onRequest?: (url: string, init?: RequestInit) => void) {
  const version = '1.2.3';
  const archive = `chatmux-server-${version}-linux-x64-node22.tar.gz`;
  return async (url: string, init?: RequestInit) => {
    onRequest?.(url, init);
    if (url.includes('/releases/latest')) return {
      ok: true, status: 200,
      json: async () => ({ tag_name: `v${version}`, published_at: '2026-01-02T03:04:05.000Z', assets: [
        { name: archive, browser_download_url: `https://github.com/devswha/chatmux/releases/download/v${version}/${archive}` },
        { name: `${archive}.sha256`, browser_download_url: checksumUrl ?? `https://github.com/devswha/chatmux/releases/download/v${version}/${archive}.sha256` },
        { name: 'install.sh', browser_download_url: `https://github.com/devswha/chatmux/releases/download/v${version}/install.sh` },
      ] }),
      text: async () => '',
    };
    if (url.includes('update-compatibility.json')) return {
      ok: true, status: 200, json: async () => ({ schema: 1, releases: { [version]: { database: { rollbackCompatibleFrom: [] } } } }), text: async () => '',
    };
    return checksumResponse(url);
  };
}

test('canonical checksum download follows only documented HTTPS asset redirects', async () => {
  const version = '1.2.3';
  const archive = `chatmux-server-${version}-linux-x64-node22.tar.gz`;
  const canonical = `https://github.com/devswha/chatmux/releases/download/v${version}/${archive}.sha256`;
  const calls: string[] = [];
  const redirectModes: Array<RequestInit['redirect']> = [];
  const release = await discoverCanonicalRelease(canonicalDiscoveryFetcher((url) => {
    calls.push(url);
    return url === canonical
      ? { ok: false, status: 302, headers: new Headers({ location: `https://objects.githubusercontent.com/${archive}.sha256?X-Amz-Signature=example` }), json: async () => ({}), text: async () => '' }
      : { ok: true, status: 200, json: async () => ({}), text: async () => `${'a'.repeat(64)}  ${archive}\n` };
  }, undefined, (_url, init) => redirectModes.push(init?.redirect)) as any);
  assert.equal(release.release.archiveSha256, 'a'.repeat(64));
  assert.deepEqual(calls, [canonical, `https://objects.githubusercontent.com/${archive}.sha256?X-Amz-Signature=example`], 'the initial canonical zero-selector URL is fetched before its permitted redirect');
  assert.deepEqual(redirectModes, ['manual', 'manual', 'manual', 'manual'], 'native fetch must expose each redirect response to the bounded redirect validator');

  await assert.rejects(discoverCanonicalRelease(canonicalDiscoveryFetcher(() => ({
    ok: false, status: 302, headers: new Headers({ location: 'https://attacker.example/checksum' }), json: async () => ({}), text: async () => '',
  })) as any), /redirect is invalid/);
  for (const location of [undefined, 'http://github.com/checksum', 'https://github.com:443/checksum', 'https://user@github.com/checksum']) {
    await assert.rejects(discoverCanonicalRelease(canonicalDiscoveryFetcher(() => ({
      ok: false, status: 302, headers: new Headers(location ? { location } : {}), json: async () => ({}), text: async () => '',
    })) as any), /redirect is invalid/);
  }
  const loop = canonicalDiscoveryFetcher((url) => ({
    ok: false, status: 302, headers: new Headers({ location: url === canonical ? 'https://github.com/loop' : canonical }), json: async () => ({}), text: async () => '',
  }));
  await assert.rejects(discoverCanonicalRelease(loop as any), /redirect loop detected/);
  let redirects = 0;
  await assert.rejects(discoverCanonicalRelease(canonicalDiscoveryFetcher(() => ({
    ok: false, status: 302, headers: new Headers({ location: `https://github.com/redirect-${redirects++}` }), json: async () => ({}), text: async () => '',
  })) as any), /redirect limit exceeded/);
  await assert.rejects(discoverCanonicalRelease(canonicalDiscoveryFetcher(() => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' }), `https://github.com:444/devswha/chatmux/releases/download/v${version}/${archive}.sha256`) as any), /checksum asset is invalid/);
});

test('canonical checksum download rejects declared and streamed oversized bodies', async () => {
  const declared = canonicalDiscoveryFetcher(() => ({ ok: true, status: 200, headers: new Headers({ 'content-length': '1000001' }), json: async () => ({}), text: async () => '' }));
  await assert.rejects(discoverCanonicalRelease(declared as any), /too large/);

  const chunked = canonicalDiscoveryFetcher(() => ({
    ok: true, status: 200, json: async () => ({}), text: async () => '',
    body: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(1_000_001)); controller.close(); } }),
  }));
  await assert.rejects(discoverCanonicalRelease(chunked as any), /too large/);
  const stalled = canonicalDiscoveryFetcher(() => ({
    ok: true, status: 200, json: async () => ({}), text: async () => '',
    body: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(1)); } }),
  }));
  await assert.rejects(discoverCanonicalRelease(stalled as any), /timed out/);
});
test('shellQuote survives embedded single quotes', () => {
  assert.equal(shellQuote("a'b"), `'a'\\''b'`);
});
test('release router restart preserves active workers and fails only proven inactive workers', () => {
  const home = tempRoot();
  const state = new ReleaseUpdateStateStore(path.join(home, '.chatmux', 'update'), { now: () => 10 });
  const active = releaseJob(1);
  state.createIfNoActive(active);
  createSystemRouter({ appRoot: home, home, serverPort: 3000, bootId: 'boot', runningVersion: '1.0.0', mode: 'release', state, isReleaseUpdateUnitLive: (unit) => {
    assert.equal(unit, `chatmux-release-update-${active.id}`);
    return true;
  } });
  assert.equal(state.publicActiveStatus()?.id, active.id);

  const deadHome = tempRoot();
  const deadState = new ReleaseUpdateStateStore(path.join(deadHome, '.chatmux', 'update'), { now: () => 10 });
  const dead = releaseJob(2);
  deadState.createIfNoActive(dead);
  createSystemRouter({ appRoot: deadHome, home: deadHome, serverPort: 3000, bootId: 'boot', runningVersion: '1.0.0', mode: 'release', state: deadState, isReleaseUpdateUnitLive: () => mapSystemctlIsActiveResult({ status: 4 }) === 'live' });
  assert.equal(deadState.publicStatus(dead.id)?.error, 'Updater stopped before completion');
  assert.ok(deadState.createIfNoActive(releaseJob(3)));

  const uncertainHome = tempRoot();
  const uncertainState = new ReleaseUpdateStateStore(path.join(uncertainHome, '.chatmux', 'update'));
  const uncertain = releaseJob(4);
  uncertainState.createIfNoActive(uncertain);
  createSystemRouter({ appRoot: uncertainHome, home: uncertainHome, serverPort: 3000, bootId: 'boot', runningVersion: '1.0.0', mode: 'release', state: uncertainState, isReleaseUpdateUnitLive: () => { throw new Error('systemctl unavailable'); } });
  assert.equal(uncertainState.publicActiveStatus()?.id, uncertain.id);
});
