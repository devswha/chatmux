#!/usr/bin/env node
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const ARCHIVE_NAME = (version) => `chatmux-server-${version}-linux-x64-node22.tar.gz`;
const HEALTH_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 10_000;

export function canonicalAssets(version) {
  if (typeof version !== 'string' || !SEMVER.test(version)) throw new Error('Compatibility versions must be exact stable SemVer values.');
  const archiveName = ARCHIVE_NAME(version);
  return { archiveName, checksumName: `${archiveName}.sha256` };
}

export function declaredRollbackVersions(declaration, targetVersion) {
  const entry = declaration?.schema === 1 && declaration?.releases?.[targetVersion];
  const versions = entry?.database?.rollbackCompatibleFrom;
  if (!Array.isArray(versions) || versions.some((version) => typeof version !== 'string' || !SEMVER.test(version)) || new Set(versions).size !== versions.length) {
    throw new Error(`No exact rollback compatibility declaration exists for ${targetVersion}.`);
  }
  return [...versions];
}

export function verifyChecksum(checksum, archive, archiveName) {
  const match = /^([a-f0-9]{64}) {2}([^/\n]+)\n$/u.exec(checksum);
  if (!match || match[2] !== archiveName) throw new Error('Old release checksum is not canonical.');
  const actual = crypto.createHash('sha256').update(archive).digest('hex');
  if (actual !== match[1]) throw new Error('Old release checksum does not match its archive.');
}

export async function proveRollbackCompatibility({
  targetVersion, declaration, fetchExactAsset, extractSafely, copyRepresentativeDatabase,
  runTargetMigrations, bootOldRuntime, assertHealth, exerciseRepresentativeRead, exerciseRepresentativeWrite,
}) {
  const oldVersions = declaredRollbackVersions(declaration, targetVersion);
  if (oldVersions.length === 0) return { targetVersion, proven: [] };
  const required = [fetchExactAsset, extractSafely, copyRepresentativeDatabase, runTargetMigrations, bootOldRuntime, assertHealth, exerciseRepresentativeRead, exerciseRepresentativeWrite];
  if (required.some((seam) => typeof seam !== 'function')) throw new Error('Compatibility proof requires every injected execution seam.');
  const proven = [];
  for (const oldVersion of oldVersions) {
    const { archiveName, checksumName } = canonicalAssets(oldVersion);
    const [archive, checksum] = await Promise.all([fetchExactAsset(oldVersion, archiveName), fetchExactAsset(oldVersion, checksumName)]);
    verifyChecksum(String(checksum), Buffer.isBuffer(archive) ? archive : Buffer.from(archive), archiveName);
    const oldRuntime = await extractSafely({ version: oldVersion, archiveName, archive });
    const database = await copyRepresentativeDatabase({ fromVersion: oldVersion, oldRuntime });
    await runTargetMigrations({ targetVersion, database });
    const oldProcess = await bootOldRuntime({ version: oldVersion, runtime: oldRuntime, database });
    try {
      const health = await assertHealth({ version: oldVersion, process: oldProcess });
      if (health?.product !== 'chatmux' || health?.status !== 'ok' || health?.version !== oldVersion) throw new Error('Old runtime health identity did not match the exact release.');
      const session = await exerciseRepresentativeRead({ version: oldVersion, process: oldProcess });
      await exerciseRepresentativeWrite({ version: oldVersion, process: oldProcess, session });
    } finally {
      await oldProcess?.stop?.();
    }
    proven.push(oldVersion);
  }
  return { targetVersion, proven };
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', ...options });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`${command} ${args.join(' ')} exited with code ${code}`)));
  });
}

async function safeExtract(archivePath, destination) {
  const listing = await new Promise((resolve, reject) => {
    const child = spawn('tar', ['-tvzf', archivePath], { stdio: ['ignore', 'pipe', 'inherit'] });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve(output) : reject(new Error(`Unable to inspect ${archivePath}.`)));
  });
  const names = await new Promise((resolve, reject) => {
    const child = spawn('tar', ['-tzf', archivePath], { stdio: ['ignore', 'pipe', 'inherit'] });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve(output) : reject(new Error(`Unable to list ${archivePath}.`)));
  });
  for (const entry of names.trim().split('\n').filter(Boolean)) {
    if (entry.includes('image.png') || entry.startsWith('/') || entry.split('/').includes('..') || !entry.startsWith('./')) {
      throw new Error(`Unsafe archive path in ${path.basename(archivePath)}: ${entry}`);
    }
  }
  for (const line of listing.trim().split('\n').filter(Boolean)) {
    const mode = line.trim().split(/\s+/u, 1)[0]?.[0];
    const linkMarker = line.indexOf(' -> ');
    const hardLinkMarker = line.indexOf(' link to ');
    const marker = linkMarker >= 0 ? linkMarker : hardLinkMarker;
    const entryPart = marker >= 0 ? line.slice(0, marker) : line;
    const entry = entryPart.trim().split(/\s+/u).at(-1);
    const linkTarget = marker >= 0 ? line.slice(marker + (linkMarker >= 0 ? 4 : 9)).trim() : null;
    const resolvedLinkTarget = linkTarget && path.posix.normalize(path.posix.join(path.posix.dirname(entry), linkTarget));
    if (!['-', 'd', 'l', 'h'].includes(mode) || !entry || entry.includes('image.png') || entry.startsWith('/') || entry.split('/').includes('..') ||
      (linkTarget && (linkTarget.startsWith('/') || resolvedLinkTarget.startsWith('../')))) {
      throw new Error(`Unsafe archive entry in ${path.basename(archivePath)}: ${line}`);
    }
  }
  await fs.mkdir(destination, { recursive: true });
  await run('tar', ['-xzf', archivePath, '--no-same-owner', '--no-same-permissions', '-C', destination]);
  return destination;
}

async function request(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  const text = await response.text();
  if (!response.ok) throw new Error(`${options.method || 'GET'} ${url} returned ${response.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

async function waitForHealth(url, logPath, expectedVersion) {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const health = await request(`${url}/health`);
      if (health?.product === 'chatmux' && health?.status === 'ok' && (expectedVersion === undefined || health?.version === expectedVersion)) return health;
      lastError = new Error('Runtime health identity did not match the expected release.');
    } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const log = await fs.readFile(logPath, 'utf8').catch(() => 'log unavailable');
  throw new Error(`Runtime did not become healthy: ${lastError?.message || 'unknown error'}\n${log.slice(-4000)}`);
}

function startRuntime({ runtime, home, port, label, evidenceDir }) {
  const logPath = path.join(evidenceDir, `${label}.log`);
  const child = spawn(process.execPath, ['scripts/chatmux-runtime.mjs', 'start'], {
    cwd: runtime,
    env: { ...process.env, HOME: home, HOST: '127.0.0.1', SERVER_PORT: String(port), CHATMUX_AUTH: 'password' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = [];
  child.stdout.on('data', (chunk) => log.push(chunk));
  child.stderr.on('data', (chunk) => log.push(chunk));
  const flushed = new Promise((resolve) => child.once('exit', resolve));
  return {
    url: `http://127.0.0.1:${port}`,
    async stop() {
      if (child.exitCode === null) child.kill('SIGTERM');
      await Promise.race([flushed, new Promise((resolve) => setTimeout(resolve, 5_000))]);
      if (child.exitCode === null) {
        child.kill('SIGKILL');
        await Promise.race([flushed, new Promise((resolve) => setTimeout(resolve, 2_000))]);
      }
      await fs.writeFile(logPath, Buffer.concat(log));
    },
    logPath,
  };
}

async function seedOldData(runtime, home, port, evidenceDir) {
  const process = startRuntime({ runtime, home, port, label: 'old-seed', evidenceDir });
  try {
    await waitForHealth(process.url, process.logPath);
    const username = 'rollback-proof';
    const password = 'rollback-proof-password';
    const registration = await request(`${process.url}/api/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
    if (!registration?.token) throw new Error('Old runtime registration did not persist an authentication token.');
    return { username, password };
  } finally { await process.stop(); }
}

async function migrateTarget(runtime, home, port, evidenceDir) {
  const process = startRuntime({ runtime, home, port, label: 'target-migration', evidenceDir });
  try { await waitForHealth(process.url, process.logPath); } finally { await process.stop(); }
}

async function main() {
  const declarationPath = process.env.CHATMUX_UPDATE_COMPATIBILITY_DECLARATION;
  const targetVersion = process.env.CHATMUX_TARGET_VERSION;
  const targetArchive = process.env.CHATMUX_TARGET_ARCHIVE;
  const targetChecksum = process.env.CHATMUX_TARGET_CHECKSUM;
  const repository = process.env.CHATMUX_RELEASE_REPOSITORY;
  const evidenceDir = path.resolve(process.env.CHATMUX_COMPATIBILITY_EVIDENCE_DIR || 'rollback-compatibility-evidence');
  if (!declarationPath || !targetVersion || !targetArchive || !targetChecksum || !repository) throw new Error('CHATMUX_UPDATE_COMPATIBILITY_DECLARATION, CHATMUX_TARGET_VERSION, CHATMUX_TARGET_ARCHIVE, CHATMUX_TARGET_CHECKSUM, and CHATMUX_RELEASE_REPOSITORY are required.');
  const declaration = JSON.parse(await fs.readFile(path.resolve(declarationPath), 'utf8'));
  const targetAssets = canonicalAssets(targetVersion);
  if (path.basename(targetArchive) !== targetAssets.archiveName || path.basename(targetChecksum) !== targetAssets.checksumName) throw new Error('Target artifact inputs do not match the exact target version.');
  const targetBuffer = await fs.readFile(targetArchive);
  verifyChecksum(await fs.readFile(targetChecksum, 'utf8'), targetBuffer, targetAssets.archiveName);
  await fs.mkdir(evidenceDir, { recursive: true });
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmux-rollback-proof-'));
  const ports = new Set();
  const port = () => { let value; do { value = 41000 + Math.floor(Math.random() * 20000); } while (ports.has(value)); ports.add(value); return value; };
  try {
    const targetRuntime = await safeExtract(targetArchive, path.join(workDir, 'target-runtime'));
    const result = await proveRollbackCompatibility({
      targetVersion, declaration,
      fetchExactAsset: async (version, name) => {
        const destination = path.join(workDir, 'assets', version);
        await fs.mkdir(destination, { recursive: true });
        await run('gh', ['release', 'download', `v${version}`, '--repo', repository, '--pattern', name, '--dir', destination]);
        return fs.readFile(path.join(destination, name));
      },
      extractSafely: async ({ version, archiveName, archive }) => {
        const archivePath = path.join(workDir, 'assets', version, archiveName);
        if (!Buffer.isBuffer(archive)) throw new Error('Downloaded archive must be a buffer.');
        return safeExtract(archivePath, path.join(workDir, 'old-runtime', version));
      },
      copyRepresentativeDatabase: async ({ fromVersion, oldRuntime }) => {
        const sourceHome = path.join(workDir, 'old-home', fromVersion);
        const migratedHome = path.join(workDir, 'migrated-home', fromVersion);
        await fs.mkdir(sourceHome, { recursive: true });
        const credentials = await seedOldData(oldRuntime, sourceHome, port(), evidenceDir);
        await fs.cp(sourceHome, migratedHome, { recursive: true });
        await fs.writeFile(path.join(evidenceDir, `${fromVersion}-credentials.json`), JSON.stringify({ username: credentials.username }) + '\n');
        return { home: migratedHome, credentials };
      },
      runTargetMigrations: async ({ database }) => migrateTarget(targetRuntime, database.home, port(), evidenceDir),
      bootOldRuntime: async ({ version, runtime, database }) => {
        const process = startRuntime({ runtime, home: database.home, port: port(), label: `old-${version}-rollback`, evidenceDir });
        process.credentials = database.credentials;
        await waitForHealth(process.url, process.logPath, version);
        return process;
      },
      assertHealth: async ({ version, process }) => waitForHealth(process.url, process.logPath, version),
      exerciseRepresentativeRead: async ({ process }) => {
        const { username, password } = process.credentials;
        const status = await request(`${process.url}/api/auth/status`);
        if (status?.needsSetup !== false) throw new Error('Migrated database lost the old persisted user.');
        const login = await request(`${process.url}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
        if (!login?.token) throw new Error('Old runtime could not read migrated persisted user data.');
        return { username, password, token: login.token };
      },
      exerciseRepresentativeWrite: async ({ process, session }) => {
        const authorization = { authorization: `Bearer ${session.token}` };
        await request(`${process.url}/api/auth/logout`, { method: 'POST', headers: authorization });
        const revoked = await fetch(`${process.url}/api/auth/user`, { headers: authorization, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
        if (revoked.ok) throw new Error('Old runtime logout did not persist token revocation.');
        const login = await request(`${process.url}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: session.username, password: session.password }) });
        if (!login?.token) throw new Error('Old runtime could not persist a post-revocation login.');
        const user = await request(`${process.url}/api/auth/user`, { headers: { authorization: `Bearer ${login.token}` } });
        if (user?.user?.username !== session.username) throw new Error('Old runtime could not read the post-write persisted user session.');
      },
    });
    await fs.writeFile(path.join(evidenceDir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
    console.log(JSON.stringify(result));
  } finally { await fs.rm(workDir, { recursive: true, force: true }); }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
