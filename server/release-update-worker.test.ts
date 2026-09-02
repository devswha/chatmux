import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { ReleaseUpdateStateStore } from './release-update-state.js';
import { createFixedRun, ReleaseUpdateWorker, ReleaseUpdateWorkerCrash, ReleaseUpdateWorkerError, pollHealth, validateTarListing } from './release-update-worker.js';

test('tar pre-enumeration permits canonical root, directory, and package file entries', () => {
  assert.doesNotThrow(() => validateTarListing([
    'drwxr-xr-x owner/group 0 2026-01-01 00:00 ./',
    'drwxr-xr-x owner/group 0 2026-01-01 00:00 ./package/',
    '-rw-r--r-- owner/group 42 2026-01-01 00:00 ./package/package.json',
  ].join('\n')));
});
test('tar pre-enumeration permits an internal relative symlink', () => {
  assert.doesNotThrow(() => validateTarListing([
    'drwxr-xr-x owner/group 0 2026-01-01 00:00 package',
    '-rw-r--r-- owner/group 42 2026-01-01 00:00 package/package.json',
    'lrwxrwxrwx owner/group 0 2026-01-01 00:00 package/node_modules-link -> ../package',
  ].join('\n')));
});

test('tar pre-enumeration rejects traversal, writable entries, and device types', () => {
  for (const listing of [
    '-rw-r--r-- owner/group 1 2026-01-01 00:00 ../package.json',
    '-rw-rw-r-- owner/group 1 2026-01-01 00:00 package/package.json',
    'crw-r--r-- owner/group 1 2026-01-01 00:00 package/device',
    'lrwxrwxrwx owner/group 0 2026-01-01 00:00 package/escape -> ../../outside',
  ]) assert.throws(() => validateTarListing(listing), ReleaseUpdateWorkerError);
});

test('worker fails closed before any filesystem or process effect for invalid CLI job ids', async () => {
  const effects: string[] = [];
  const worker = new ReleaseUpdateWorker({
    home: '/home/owner',
    store: { get: () => { effects.push('get'); return null; }, transition: () => { effects.push('transition'); throw new Error('unexpected'); }, persistRecoveryCheckpoint: () => { effects.push('checkpoint'); throw new Error('unexpected'); }, recordDownloadProgress: () => { effects.push('progress'); throw new Error('unexpected'); } },
    fs: new Proxy({}, { get: () => () => { effects.push('filesystem'); throw new Error('unexpected'); } }) as never,
    run: async () => { effects.push('process'); return { code: 0, stdout: '', stderr: '' }; },
    health: async () => { effects.push('health'); return true; },
  });
  await assert.rejects(worker.run('../not-a-job'), ReleaseUpdateWorkerError);
  assert.deepEqual(effects, []);
});

test('worker records a durable failed outcome when the immutable job is unavailable', async () => {
  const transitions: string[] = [];
  const worker = new ReleaseUpdateWorker({
    home: '/home/owner',
    store: { get: () => null, transition: (_id, phase) => { transitions.push(phase); return undefined as never; }, persistRecoveryCheckpoint: () => undefined as never, recordDownloadProgress: () => undefined as never },
  });
  await assert.rejects(worker.run('AbCdEfGhIjKlMnOpQrStUv'), ReleaseUpdateWorkerError);
  assert.deepEqual(transitions, []);
});
test('pre-cutover staging faults become a durable failed outcome without invoking process or health seams', async () => {
  const id = 'AbCdEfGhIjKlMnOpQrStUv';
  const phases: string[] = [];
  const worker = new ReleaseUpdateWorker({
    home: '/home/owner',
    store: {
      get: () => ({
        descriptor: {
          id,
          release: { repository: 'devswha/chatmux', tag: 'v1.2.3', version: '1.2.3', archiveName: 'chatmux-server-1.2.3-linux-x64-node22.tar.gz', checksumName: 'chatmux-server-1.2.3-linux-x64-node22.tar.gz.sha256', bootstrapName: 'install.sh', archiveSha256: 'a'.repeat(64), publishedAt: '2026-01-01T00:00:00.000Z' },
          compatibility: { database: { rollbackCompatibleFrom: ['1.0.0'] } },
          createdAt: 0,
          installMode: 'release',
          sourceVersion: '1.0.0',
          sourceBootId: 'boot-before-update',
          serverPort: 3000,
        },
        phase: 'queued',
        updatedAt: 0,
        locked: true,
      }) as never,
      transition: (_id, phase) => { phases.push(phase); return undefined as never; },
      persistRecoveryCheckpoint: () => undefined as never,
      recordDownloadProgress: () => undefined as never,
    },
    fs: { mkdir: async () => { throw new Error('disk fault'); }, rm: async () => undefined } as never,
    run: async () => { throw new Error('process must not run'); },
    health: async () => { throw new Error('health must not run'); },
  });
  await worker.run(id);
  assert.deepEqual(phases, ['failed']);
});

const jobId = 'AbCdEfGhIjKlMnOpQrStUv';
const archive = Buffer.from('tiny release archive');
const archiveHash = createHash('sha256').update(archive).digest('hex');
const tarListing = [
  'drwxr-xr-x owner/group 0 2026-01-01 00:00 package',
  '-rw-r--r-- owner/group 42 2026-01-01 00:00 package/package.json',
].join('\n');

async function releaseTree(directory: string, version: string, compatibility = ['1.0.0']): Promise<void> {
  await fs.mkdir(path.join(directory, 'scripts'), { recursive: true, mode: 0o755 });
  await fs.mkdir(path.join(directory, 'dist-server', 'server'), { recursive: true, mode: 0o755 });
  await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({ version }), { mode: 0o644 });
  await fs.writeFile(path.join(directory, 'release-update-metadata.json'), JSON.stringify({
    schema: 1, updaterProtocol: 1, version, compatibility: { database: { rollbackCompatibleFrom: compatibility } },
  }), { mode: 0o644 });
  await fs.writeFile(path.join(directory, 'scripts', 'chatmux-runtime.mjs'), '', { mode: 0o644 });
  await fs.writeFile(path.join(directory, 'dist-server', 'server', 'release-update-worker.js'), '', { mode: 0o644 });
}

async function workerFixture(options: { healthHost?: string;
  sourceVersion?: string;
  compatibleFrom?: string[];
  health?: (version: string) => boolean;
  restartFails?: number;
  fetch?: (url: string, signal: AbortSignal) => AsyncIterable<Uint8Array>;
  requestTimeoutMs?: number;
  nativeResponse?: boolean;
  contentLength?: boolean;
  crashAt?: 'prepared' | 'live_link_swapped' | 'rollback_in_progress' | 'rollback_link_restored' | 'rollback_completed' | 'terminalized';
} = {}) {
  const home = await fs.mkdtemp(path.join(tmpdir(), 'chatmux-release-worker-'));
  const root = path.join(home, '.chatmux');
  const releases = path.join(root, 'releases');
  const priorVersion = '1.0.0';
  const targetVersion = '1.2.3';
  const prior = path.join(releases, priorVersion);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  await fs.chmod(root, 0o700);
  await releaseTree(prior, priorVersion);
  await fs.symlink(prior, path.join(root, 'current'));

  const descriptor = {
    id: jobId,
    release: {
      repository: 'devswha/chatmux' as const, tag: `v${targetVersion}`, version: targetVersion,
      archiveName: `chatmux-server-${targetVersion}-linux-x64-node22.tar.gz`,
      checksumName: `chatmux-server-${targetVersion}-linux-x64-node22.tar.gz.sha256`,
      bootstrapName: 'install.sh' as const, archiveSha256: archiveHash, publishedAt: '2026-01-01T00:00:00.000Z',
    },
    compatibility: { database: { rollbackCompatibleFrom: options.compatibleFrom ?? [priorVersion] } },
    createdAt: 1, installMode: 'release' as const, sourceVersion: options.sourceVersion ?? priorVersion,
    sourceBootId: 'boot-before-update', serverPort: 43123,
  };
  const state = new ReleaseUpdateStateStore(path.join(root, 'update'), { now: () => 2 });
  state.initialize();
  state.create(descriptor);
  const phases: string[] = [];
  const commands: Array<[string, readonly string[]]> = [];
  const commandEnvironments: NodeJS.ProcessEnv[] = [];
  const healthArgs: Array<[string, number, string, string]> = [];
  let restartCount = 0;
  const progressWrites: Array<{ downloadedBytes: number; totalBytes?: number }> = [];
  const worker = new ReleaseUpdateWorker({
    home,
    store: {
      get: state.get.bind(state),
      transition: (id, phase, error) => {
        phases.push(phase);
        return state.transition(id, phase, error);
      },
      persistRecoveryCheckpoint: state.persistRecoveryCheckpoint.bind(state),
      recordDownloadProgress: (id, progress) => {
        progressWrites.push(progress);
        return state.recordDownloadProgress(id, progress);
      },
    },
    fetch: async (url, fetchOptions) => {
      const body = options.fetch?.(url, fetchOptions.signal) ?? (async function* () {
        yield url.endsWith('.sha256')
          ? Buffer.from(`${archiveHash}  ${descriptor.release.archiveName}\n`)
          : archive;
      })();
      if (options.nativeResponse) {
        const chunks: Uint8Array[] = [];
        for await (const chunk of body) chunks.push(chunk);
        return new Response(Buffer.concat(chunks), { status: 200 }) as never;
      }
      return {
        status: 200,
        headers: { get: (name: string) => (options.contentLength && name.toLowerCase() === 'content-length' && !url.endsWith('.sha256') ? String(archive.byteLength) : null) },
        body,
      };
    },
    run: async (command, args, processOptions) => {
      commandEnvironments.push(processOptions?.env ?? {});
      commands.push([command, args]);
      if (command === '/usr/bin/tar' && args[0] === '--extract') {
        await releaseTree(String(args[args.indexOf('--directory') + 1]), targetVersion, options.compatibleFrom);
      }
      if (command === '/usr/bin/systemctl') {
        restartCount += 1;
        if (restartCount <= (options.restartFails ?? 0)) return { code: 1, stdout: '', stderr: 'restart failed' };
      }
      return { code: 0, stdout: command === '/usr/bin/tar' ? tarListing : '', stderr: '' };
    },
    healthHost: options.healthHost,
    health: async (version, port, bootId, host) => {
      healthArgs.push([version, port, bootId, host]);
      return options.health?.(version) ?? true;
    },
    requestTimeoutMs: options.requestTimeoutMs,
    onDurableBoundary: (boundary) => {
      if (boundary === options.crashAt) throw new ReleaseUpdateWorkerCrash(`crash at ${boundary}`);
    },
  });
  return {
    root, releases, prior, descriptor, state, phases, commands, commandEnvironments, healthArgs, worker, progressWrites,
    cleanup: () => fs.rm(home, { recursive: true, force: true }),
  };
}

test('worker performs a complete staged cutover with exact health descriptor arguments', async () => {
  const fixture = await workerFixture();
  try {
    await fixture.worker.run(jobId);
    assert.deepEqual(fixture.phases, ['downloading', 'verifying', 'staging', 'cutting_over', 'restarting', 'verifying_health', 'succeeded']);
    assert.equal(await fs.readlink(path.join(fixture.root, 'current')), path.join(fixture.releases, '1.2.3'));
    assert.deepEqual(fixture.healthArgs, [['1.2.3', fixture.descriptor.serverPort, fixture.descriptor.sourceBootId, '127.0.0.1']], 'descriptors without a host probe loopback');
    assert.deepEqual(fixture.commands.filter(([command]) => command === '/usr/bin/systemctl'), [
      ['/usr/bin/systemctl', ['--user', 'restart', 'chatmux.service']],
    ]);
    const allowedEnvironmentKeys = new Set(['HOME', 'LANG', 'LC_ALL', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS']);
    assert.ok(fixture.commandEnvironments.length > 0);
    for (const environment of fixture.commandEnvironments) {
      assert.ok(Object.keys(environment).every((key) => allowedEnvironmentKeys.has(key)));
    }
    assert.equal(fixture.state.get(jobId)?.phase, 'succeeded');
  } finally { await fixture.cleanup(); }
});

test('worker persists durable archive download progress with and without a declared total', async () => {
  const sized = await workerFixture({ contentLength: true });
  try {
    await sized.worker.run(jobId);
    assert.deepEqual(sized.progressWrites.at(-1), { downloadedBytes: archive.byteLength, totalBytes: archive.byteLength });
    assert.ok(sized.progressWrites.every((write) => write.totalBytes === archive.byteLength));
  } finally { await sized.cleanup(); }
  // Unsized multi-chunk body inside the throttle window: the terminal flush
  // must still persist the true byte count, not the first chunk's.
  const half = Math.floor(archive.byteLength / 2);
  const unsized = await workerFixture({
    fetch: (url) => (async function* () {
      if (url.endsWith('.sha256')) { yield Buffer.from(`${archiveHash}  chatmux-server-1.2.3-linux-x64-node22.tar.gz\n`); return; }
      yield archive.subarray(0, half);
      yield archive.subarray(half);
    })(),
  });
  try {
    await unsized.worker.run(jobId);
    assert.deepEqual(unsized.progressWrites.at(-1), { downloadedBytes: archive.byteLength });
    assert.ok(unsized.progressWrites.some((write) => write.downloadedBytes === half));
  } finally { await unsized.cleanup(); }
});

test('worker preserves native Response status, headers, and body across its bounded timer wrapper', async () => {
  const fixture = await workerFixture({ nativeResponse: true });
  try {
    await fixture.worker.run(jobId);
    assert.equal(fixture.state.get(jobId)?.phase, 'succeeded');
  } finally { await fixture.cleanup(); }
});

test('worker rolls back the current link when target health fails', async () => {
  const fixture = await workerFixture({ health: (version) => version === '1.0.0' });
  try {
    await fixture.worker.run(jobId);
    assert.deepEqual(fixture.phases, ['downloading', 'verifying', 'staging', 'cutting_over', 'restarting', 'verifying_health', 'rolling_back', 'failed_rolled_back']);
    assert.equal(await fs.readlink(path.join(fixture.root, 'current')), fixture.prior);
    assert.deepEqual(fixture.healthArgs.map(([version]) => version), ['1.2.3', '1.0.0']);
    assert.equal(fixture.commands.filter(([command]) => command === '/usr/bin/systemctl').length, 2);
    assert.equal(fixture.state.get(jobId)?.phase, 'failed_rolled_back');
    await assert.rejects(fs.lstat(path.join(fixture.releases, '1.2.3')));
  } finally { await fixture.cleanup(); }
});

test('worker rolls back after a post-cutover systemctl restart failure', async () => {
  const fixture = await workerFixture({ restartFails: 1 });
  try {
    await fixture.worker.run(jobId);
    assert.deepEqual(fixture.phases, ['downloading', 'verifying', 'staging', 'cutting_over', 'restarting', 'rolling_back', 'failed_rolled_back']);
    assert.equal(await fs.readlink(path.join(fixture.root, 'current')), fixture.prior);
    assert.deepEqual(fixture.healthArgs.map(([version]) => version), ['1.0.0']);
    assert.equal(fixture.commands.filter(([command]) => command === '/usr/bin/systemctl').length, 2);
    assert.equal(fixture.state.get(jobId)?.phase, 'failed_rolled_back');
    await assert.rejects(fs.lstat(path.join(fixture.releases, '1.2.3')));
  } finally { await fixture.cleanup(); }
});

test('worker reports failed_rollback when rollback restart cannot recover the prior release', async () => {
  const fixture = await workerFixture({ health: () => false, restartFails: 2 });
  try {
    await fixture.worker.run(jobId);
    assert.deepEqual(fixture.phases, ['downloading', 'verifying', 'staging', 'cutting_over', 'restarting', 'rolling_back', 'failed_rollback']);
    assert.equal(await fs.readlink(path.join(fixture.root, 'current')), fixture.prior);
    assert.equal(fixture.commands.filter(([command]) => command === '/usr/bin/systemctl').length, 2);
    assert.equal(fixture.state.get(jobId)?.phase, 'failed_rollback');
    assert.equal(fixture.state.get(jobId)?.recovery?.rollbackState, 'failed');
  } finally { await fixture.cleanup(); }
});
test('durable recovery boundaries retain authority through dead-worker reconciliation', async () => {
  const cases: Array<{
    boundary: 'prepared' | 'live_link_swapped' | 'rollback_in_progress' | 'rollback_link_restored' | 'rollback_completed' | 'terminalized';
    health?: (version: string) => boolean;
    phase: string;
    cutoverState: 'prepared' | 'live_link_swapped';
    rollbackState: 'not_started' | 'in_progress' | 'completed' | 'failed';
    current: 'prior' | 'target';
  }> = [
    { boundary: 'prepared', phase: 'failed', cutoverState: 'prepared', rollbackState: 'not_started', current: 'prior' },
    { boundary: 'live_link_swapped', phase: 'manual_required', cutoverState: 'live_link_swapped', rollbackState: 'not_started', current: 'target' },
    { boundary: 'rollback_in_progress', health: () => false, phase: 'failed_rollback', cutoverState: 'live_link_swapped', rollbackState: 'in_progress', current: 'target' },
    { boundary: 'rollback_link_restored', health: () => false, phase: 'failed_rollback', cutoverState: 'live_link_swapped', rollbackState: 'in_progress', current: 'prior' },
    { boundary: 'rollback_completed', health: (version) => version === '1.0.0', phase: 'failed_rolled_back', cutoverState: 'live_link_swapped', rollbackState: 'completed', current: 'prior' },
    { boundary: 'terminalized', health: () => false, phase: 'failed_rollback', cutoverState: 'live_link_swapped', rollbackState: 'failed', current: 'prior' },
  ];
  for (const scenario of cases) {
    const fixture = await workerFixture({ crashAt: scenario.boundary, health: scenario.health });
    try {
      await assert.rejects(fixture.worker.run(jobId), ReleaseUpdateWorkerCrash);
      const reopened = new ReleaseUpdateStateStore(path.join(fixture.root, 'update'), { now: () => 3 });
      reopened.initialize();
      reopened.reconcileLocks(() => false);
      reopened.failIfInactive(jobId, () => false);
      const retained = reopened.get(jobId);
      assert.equal(retained?.phase, scenario.phase, scenario.boundary);
      assert.deepEqual(retained?.recovery, {
        priorRelease: { path: fixture.prior, version: '1.0.0' },
        targetRelease: { path: path.join(fixture.releases, '1.2.3'), version: '1.2.3' },
        cutoverState: scenario.cutoverState,
        rollbackState: scenario.rollbackState,
      }, scenario.boundary);
      assert.equal(await fs.readlink(path.join(fixture.root, 'current')), scenario.current === 'prior' ? fixture.prior : path.join(fixture.releases, '1.2.3'), scenario.boundary);
    } finally { await fixture.cleanup(); }
  }
});

test('fixed process runner rejects subprocess timeout and output caps deterministically', async () => {
  const timeout = createFixedRun({ timeoutMs: 10, maxStdoutBytes: 128, maxStderrBytes: 128 });
  await assert.rejects(timeout(process.execPath, ['-e', 'setInterval(() => {}, 1000)']), ReleaseUpdateWorkerError);

  const stdout = createFixedRun({ timeoutMs: 1_000, maxStdoutBytes: 8, maxStderrBytes: 128 });
  await assert.rejects(stdout(process.execPath, ['-e', 'process.stdout.write("x".repeat(64))']), ReleaseUpdateWorkerError);

  const stderr = createFixedRun({ timeoutMs: 1_000, maxStdoutBytes: 128, maxStderrBytes: 8 });
  await assert.rejects(stderr(process.execPath, ['-e', 'process.stderr.write("x".repeat(64))']), ReleaseUpdateWorkerError);
});

test('worker requires manual intervention before cutover for incompatible staged metadata', async () => {
  const fixture = await workerFixture({ compatibleFrom: ['0.9.0'] });
  try {
    await fixture.worker.run(jobId);
    assert.deepEqual(fixture.phases, ['downloading', 'verifying', 'staging', 'manual_required']);
    assert.equal(await fs.readlink(path.join(fixture.root, 'current')), fixture.prior);
    await assert.rejects(fs.lstat(path.join(fixture.releases, '1.2.3')));
    assert.equal(fixture.state.get(jobId)?.phase, 'manual_required');
  } finally { await fixture.cleanup(); }
});

test('worker rejects a source version and current-link mismatch before downloading', async () => {
  const fixture = await workerFixture({ sourceVersion: '1.0.1' });
  try {
    await fixture.worker.run(jobId);
    assert.deepEqual(fixture.phases, ['failed']);
    assert.equal(await fs.readlink(path.join(fixture.root, 'current')), fixture.prior);
    assert.deepEqual(fixture.commands, []);
    assert.equal(fixture.state.get(jobId)?.phase, 'failed');
  } finally { await fixture.cleanup(); }
});
test('worker keeps the download deadline active while an archive body stalls', async () => {
  let aborted = false;
  const fixture = await workerFixture({
    requestTimeoutMs: 1,
    fetch: (_url, signal) => ({
      [Symbol.asyncIterator]() {
        return {
          next: async (): Promise<IteratorResult<Uint8Array>> => {
            await new Promise<void>((resolve) => signal.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true }));
            throw new Error('stalled body aborted');
          },
        };
      },
    }),
  });
  try {
    await fixture.worker.run(jobId);
    assert.equal(aborted, true);
    assert.deepEqual(fixture.phases, ['downloading', 'failed']);
  } finally { await fixture.cleanup(); }
});

test('health polling tolerates startup and malformed responses before requiring an exact new boot', async () => {
  let attempts = 0; const sleeps: number[] = [];
  const healthy = await pollHealth('1.2.3', 43123, 'old-boot', {
    fetch: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('starting');
      if (attempts === 2) return { status: 200, json: async () => { throw new Error('malformed'); } } as unknown as Response;
      return { status: 200, json: async () => ({ product: 'chatmux', status: 'ok', version: '1.2.3', bootId: 'new-boot' }) } as unknown as Response;
    },
    sleep: async (milliseconds) => { sleeps.push(milliseconds); },
  });
  assert.equal(healthy, true);
  assert.equal(attempts, 3);
  assert.deepEqual(sleeps, [1_000, 1_000]);
});

test('health polling targets the descriptor host, formats IPv6 literals, and refuses malformed hosts', async () => {
  const urls: string[] = [];
  const fetchOk = async (url: string) => { urls.push(url); return { status: 200, json: async () => ({ product: 'chatmux', status: 'ok', version: '1.2.3', bootId: 'new-boot' }) } as unknown as Response; };
  assert.equal(await pollHealth('1.2.3', 43123, 'old-boot', { fetch: fetchOk as unknown as typeof fetch }, '192.168.1.10'), true);
  assert.equal(await pollHealth('1.2.3', 43123, 'old-boot', { fetch: fetchOk as unknown as typeof fetch }, 'fd7a:115c:a1e0::1'), true);
  assert.equal(await pollHealth('1.2.3', 43123, 'old-boot', { fetch: fetchOk as unknown as typeof fetch }), true);
  assert.deepEqual(urls, [
    'http://192.168.1.10:43123/health',
    'http://[fd7a:115c:a1e0::1]:43123/health',
    'http://127.0.0.1:43123/health',
  ]);
  assert.equal(await pollHealth('1.2.3', 43123, 'old-boot', { fetch: fetchOk as unknown as typeof fetch }, 'evil host/../'), false);
  assert.equal(urls.length, 3, 'a malformed host never reaches fetch');
});

test('worker probes the address it was launched for, for the update and for the rollback', async () => {
  const fixture = await workerFixture({ healthHost: '192.168.1.10' });
  try {
    await fixture.worker.run(jobId);
    assert.deepEqual(fixture.healthArgs, [['1.2.3', fixture.descriptor.serverPort, fixture.descriptor.sourceBootId, '192.168.1.10']]);
  } finally { await fixture.cleanup(); }
});
