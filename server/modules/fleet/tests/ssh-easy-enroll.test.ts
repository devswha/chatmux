import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import express from 'express';

import { createFleetPairingRouter } from '@/modules/fleet/fleet-pairing.routes.js';
import { isSshEnrollmentPath } from '@/modules/fleet/ssh-enrollment-path.js';
import { createApiErrorMiddleware } from '@/modules/fleet/routing/api-error-middleware.js';
import { FleetHubPairingError } from '@/modules/fleet/services/fleet-hub-pairing.service.js';
import { FleetPairingFailureLimiter } from '@/modules/fleet/services/fleet-pairing-limiter.service.js';
import { SshEasyEnrollService } from '@/modules/fleet/services/ssh-easy-enroll.service.js';
import {
  SshEnrollmentError,
  SshTunnelManager,
  type SshProcess,
  type SshProcessOptions,
  type SshRunResult,
  type SshTunnelIo,
  type SshTunnelRecord,
  type SshTunnelStore,
} from '@/modules/fleet/services/ssh-tunnel.service.js';

const PEER_ID = '00000000-0000-4000-8000-000000000001';
const TOKEN = Buffer.alloc(32, 7).toString('base64url');
const PASSWORD = 's3cret password';

class FakeProcess extends EventEmitter implements SshProcess {
  readonly pid = 4321;
  stopSignals: NodeJS.Signals[] = [];
  stop(signal: NodeJS.Signals): void { this.stopSignals.push(signal); }
}

class MemoryStore implements SshTunnelStore {
  records: SshTunnelRecord[] = [];
  findByPeerId(peerId: string): SshTunnelRecord | undefined { return this.records.find((record) => record.peerId === peerId); }
  findByTarget(sshTarget: string): SshTunnelRecord | undefined { return this.records.find((record) => record.sshTarget === sshTarget); }
  list(): readonly SshTunnelRecord[] { return this.records; }
  save(record: SshTunnelRecord): void { this.records = [...this.records.filter(({ peerId }) => peerId !== record.peerId), record]; }
  delete(peerId: string): void { this.records = this.records.filter((record) => record.peerId !== peerId); }
}

class FakeIo implements SshTunnelIo {
  readonly runs: { command: string; args: readonly string[]; options: SshProcessOptions }[] = [];
  readonly spawns: { command: string; args: readonly string[]; options: SshProcessOptions; child: FakeProcess }[] = [];
  readonly writes: { path: string; data: string; mode: number }[] = [];
  readonly removals: string[] = [];
  runResults: SshRunResult[] = [];
  keyExists = true;
  failWriteAt?: number;
  failRm = false;
  askpassExecutions: Array<{ output: string; helperMode: number; payloadMode: number; helperDeleted: boolean; payloadDeleted: boolean }> = [];
  ready: () => Promise<void> = async () => undefined;
  unavailable: (port: number, controlPath: string) => Promise<void> = async () => undefined;
  onSpawn?: (child: FakeProcess) => void;
  onRun?: (command: string, args: readonly string[], options: SshProcessOptions) => SshRunResult | undefined;
  readonly existingPaths = new Set<string>();
  unavailableCalls = 0;
  allocatedPorts = [41234];
  allocatePort = async (): Promise<number> => this.allocatedPorts.shift() ?? 41234;
  fileExists = async (path: string): Promise<boolean> => path.endsWith('/id_ed25519') ? this.keyExists : this.existingPaths.has(path);
  mkdir = async (): Promise<void> => undefined;
  mkdtemp = async (): Promise<string> => mkdtemp(join(tmpdir(), 'chatmux-askpass-test-'));
  readFile = async (): Promise<string> => 'ssh-ed25519 AAAATEST chatmux-fleet-tunnel\n';
  writeFile = async (path: string, data: string, mode: number): Promise<void> => { this.writes.push({ path, data, mode }); if (this.writes.length === this.failWriteAt) throw new Error('injected write failure'); await writeFile(path, data, { mode }); };
  rm = async (path: string): Promise<void> => { this.removals.push(path); if (this.failRm) throw new Error('injected removal failure'); this.existingPaths.delete(path); await rm(path, { recursive: true, force: true }); };
  run = async (command: string, args: readonly string[], options: SshProcessOptions): Promise<SshRunResult> => {
    this.runs.push({ command, args, options });
    const helper = options.env?.SSH_ASKPASS;
    if (helper !== undefined) {
      const payload = join(helper, '..', 'payload');
      const helperMode = (await stat(helper)).mode & 0o777; const payloadMode = (await stat(payload)).mode & 0o777;
      const executed = spawnSync('/bin/sh', [helper], { encoding: 'utf8' });
      this.askpassExecutions.push({ output: executed.stdout, helperMode, payloadMode, helperDeleted: !(await this.exists(helper)), payloadDeleted: !(await this.exists(payload)) });
    }
    return this.onRun?.(command, args, options) ?? this.runResults.shift() ?? { code: 0, stdout: `Pairing token: ${TOKEN}\nExpires at: 2030-01-01T00:00:00.000Z\n`, stderr: '' };
  };
  private exists = async (path: string): Promise<boolean> => stat(path).then(() => true, () => false);
  spawn = (command: string, args: readonly string[], options: SshProcessOptions): SshProcess => {
    const child = new FakeProcess(); this.spawns.push({ command, args, options, child }); this.onSpawn?.(child); return child;
  };
  waitUntilReady = async (): Promise<void> => this.ready();
  waitUntilUnavailable = async (port: number, controlPath: string): Promise<void> => { this.unavailableCalls += 1; await this.unavailable(port, controlPath); };
  killGroup = (pid: number, signal: NodeJS.Signals): void => { this.spawns.find(({ child }) => child.pid === pid)?.child.stop(signal); };
}

type Fixture = Readonly<{ io: FakeIo; store: MemoryStore; manager: SshTunnelManager; service: SshEasyEnrollService; enrollments: Readonly<Record<string, unknown>>[]; reconciliations: string[] }>;
function responseErrorCode(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || !('error' in value)) return undefined;
  const error = value.error;
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}
function fixture(runResults: SshRunResult[] = []): Fixture {
  const io = new FakeIo(); io.runResults = [...runResults]; const store = new MemoryStore();
  const manager = new SshTunnelManager({ io, store, paths: { directory: '/hub/fleet', privateKey: '/hub/fleet/id_ed25519', publicKey: '/hub/fleet/id_ed25519.pub', knownHosts: '/hub/fleet/known_hosts' }, scheduler: { schedule: (_delay, callback) => { callback(); return { cancel: () => undefined }; } } });
  const enrollments: Readonly<Record<string, unknown>>[] = []; const reconciliations: string[] = [];
  const service = new SshEasyEnrollService({ tunnels: manager, onPersisted: () => { reconciliations.push('reconcile'); }, hubPairing: { enroll: async (input) => { enrollments.push(input); return { peerId: PEER_ID }; } } });
  return { io, store, manager, service, enrollments, reconciliations };
}

async function startRoute(subject: SshEasyEnrollService, reports: unknown[] = []): Promise<Readonly<{ url: string; close(): Promise<void> }>> {
  const app = express();
  app.use(express.json({ limit: '50mb', type: (request) => !isSshEnrollmentPath(request.url) && (request.headers['content-type'] ?? '').includes('json') }));
  app.use(express.urlencoded({ limit: '50mb', extended: true, type: (request) => !isSshEnrollmentPath(request.url) && (request.headers['content-type'] ?? '').includes('application/x-www-form-urlencoded') }));
  app.use((request, _response, next) => { Object.defineProperty(request, 'user', { value: { id: 1 } }); next(); });
  app.use('/api/fleet', createFleetPairingRouter({ authMode: 'password', limiter: new FleetPairingFailureLimiter(), pairing: { issueToken: () => ({ token: TOKEN, expiresAtMs: 1 }), redeem: () => { throw new TypeError('unused'); }, revokeHubGrant: () => false }, hubPairing: { enroll: async () => ({ peerId: PEER_ID }) }, revocation: { remove: async () => ({ localRemoval: 'removed', peerRevocation: 'revoked' }) }, sshEnrollment: subject }));
  app.use(createApiErrorMiddleware((error) => reports.push(error)));
  const server = createServer(app); await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (address === null || typeof address === 'string') throw new TypeError('server address unavailable');
  return { url: `http://127.0.0.1:${address.port}/api/fleet`, close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}

test('Given an SSH host and password, when the owner enrolls it, then the stable loopback peer is enrolled without exposing credentials', async (context) => {
  const subject = fixture([{ code: 0, stdout: `Pairing token: ${TOKEN}\nExpires at: 2030-01-01T00:00:00.000Z\n`, stderr: '' }]); const route = await startRoute(subject.service); context.after(route.close);
  const response = await fetch(`${route.url}/ssh-enroll`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sshTarget: 'alice@example.test:2222', password: PASSWORD, label: ' Lab ' }) });
  const responseBody = await response.text(); assert.equal(response.status, 201); assert.deepEqual(JSON.parse(responseBody), { peerId: PEER_ID, port: 41234 });
  assert.deepEqual(subject.enrollments, [{ peerUrl: 'ws://127.0.0.1:41234/fleet-ws', transportMode: 'ssh-loopback', token: TOKEN, label: 'Lab' }]); assert.deepEqual(subject.reconciliations, ['reconcile']);
  const tunnel = subject.io.spawns[0]; assert.ok(tunnel); assert.match(tunnel.args.join(' '), /ControlPath=\/hub\/fleet\/control-41234/); assert.match(tunnel.args.join(' '), /127\.0\.0\.1:41234:127\.0\.0\.1:3001/);
  assert.equal(tunnel.options.env?.SSH_ASKPASS, undefined); assert.ok(tunnel.args.includes('IdentitiesOnly=yes')); assert.ok(tunnel.args.includes('BatchMode=yes'));
  assert.ok(tunnel.args.includes('-L')); assert.equal(tunnel.args.includes('ClearAllForwardings=yes'), false);
  assert.ok(subject.io.runs.every(({ args }) => args.includes('ClearAllForwardings=yes')), 'exec and control commands clear inherited forwards');
  assert.deepEqual(subject.io.writes.map(({ mode }) => mode), [0o600, 0o700]);
  assert.deepEqual(subject.io.askpassExecutions, [{ output: `${PASSWORD}\n`, helperMode: 0o700, payloadMode: 0o600, helperDeleted: true, payloadDeleted: true }]);
  const authenticated = subject.io.runs.filter(({ options }) => options.env?.SSH_ASKPASS !== undefined); assert.equal(authenticated.length, 1); assert.ok(authenticated[0]?.args.includes('-N')); assert.ok(authenticated[0]?.args.includes('-f'));
  const keyInstall = subject.io.runs.find(({ args }) => (args.at(-1) ?? '').includes("printf '%s\\n'")); assert.ok(keyInstall);
  assert.match(keyInstall.args.at(-1) ?? '', /restrict,port-forwarding,permitopen="127\.0\.0\.1:3001",command="false" ssh-ed25519/);
  assert.match(keyInstall.args.at(-1) ?? '', /grep -vxF 'ssh-ed25519 AAAATEST chatmux-fleet-tunnel'/);
  assert.equal(JSON.stringify({ argv: subject.io.runs.map(({ args }) => args), env: subject.io.spawns.map(({ options }) => options.env), records: subject.store.records, body: responseBody }).includes(PASSWORD), false);
});

test('Given pairing capacity preflight rejects, when SSH enrollment starts, then no remote key or process is created', async () => {
  const io = new FakeIo(); const store = new MemoryStore(); const manager = new SshTunnelManager({ io, store, paths: { directory: '/hub/fleet', privateKey: '/hub/fleet/id_ed25519', publicKey: '/hub/fleet/id_ed25519.pub', knownHosts: '/hub/fleet/known_hosts' }, scheduler: { schedule: () => ({ cancel: () => undefined }) } });
  const service = new SshEasyEnrollService({ tunnels: manager, hubPairing: { preflight: () => { throw new FleetHubPairingError('PEER_CAPACITY_REACHED', 'full'); }, enroll: async () => ({ peerId: PEER_ID }) } });
  await assert.rejects(service.enroll({ sshTarget: 'alice@example.test', password: PASSWORD }), (error) => error instanceof SshEnrollmentError && error.code === 'PEER_LIMIT_REACHED');
  assert.deepEqual(io.writes, []); assert.deepEqual(io.runs, []); assert.deepEqual(io.spawns, []);
});

test('Given malformed SSH targets, when enrollment is requested, then each is rejected before SSH spawn', async () => {
  const subject = fixture(); const route = await startRoute(subject.service);
  try {
    for (const sshTarget of ['example.test', '@example.test', 'alice@host;touch /tmp/x', 'alice@example.test:0', 'alice@[::1']) {
      const response = await fetch(`${route.url}/ssh-enroll`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sshTarget, password: PASSWORD }) });
      assert.equal(response.status, 400); assert.equal(responseErrorCode(await response.json()), 'INVALID_SSH_TARGET');
    }
  } finally { await route.close(); }
  assert.equal(subject.io.spawns.length, 0);
});

test('Given rejected password authentication, when enrollment runs, then askpass is removed and a closed auth error is returned', async () => {
  const subject = fixture([{ code: 255, stdout: '', stderr: 'Permission denied (publickey,password).' }]); const route = await startRoute(subject.service);
  try {
    const response = await fetch(`${route.url}/ssh-enroll`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sshTarget: 'alice@example.test', password: PASSWORD }) });
    const body = await response.text(); assert.equal(response.status, 401); assert.equal(responseErrorCode(JSON.parse(body)), 'SSH_AUTH_FAILED'); assert.equal(body.includes(PASSWORD), false);
  } finally { await route.close(); }
  assert.equal(subject.io.removals.length, 1);
  assert.equal(subject.io.runs.length, 1, 'auth failure does not attempt key or master cleanup');
});

test('Given an unreachable SSH server, when enrollment runs, then it reports SSH_UNREACHABLE', async () => {
  const subject = fixture([{ code: 255, stdout: '', stderr: 'ssh: connect to host example.test port 22: Connection timed out' }]);
  await assert.rejects(subject.service.enroll({ sshTarget: 'alice@example.test', password: PASSWORD }), (error) => error instanceof Error && 'code' in error && error.code === 'SSH_UNREACHABLE');
});

test('Given both remote CLI paths are missing, when minting runs, then it reports REMOTE_CLI_FAILED', async () => {
  const missing = { code: 127, stdout: '', stderr: 'command not found' }; const subject = fixture([{ code: 0, stdout: '', stderr: '' }, { code: 0, stdout: '', stderr: '' }, missing]);
  await assert.rejects(subject.service.enroll({ sshTarget: 'alice@example.test', password: PASSWORD }), (error) => error instanceof Error && 'code' in error && error.code === 'REMOTE_CLI_FAILED');
  assert.ok(subject.io.runs.some(({ args }) => (args.at(-1) ?? '').includes('grep -vxF')), 'token-mint failure removes the installed key');
});

test('Given malformed token output, when minting runs, then no token content reaches the error', async () => {
  const leaked = `Pairing token: ${TOKEN}extra`; const subject = fixture([{ code: 0, stdout: '', stderr: '' }, { code: 0, stdout: '', stderr: '' }, { code: 0, stdout: leaked, stderr: '' }]);
  await assert.rejects(subject.service.enroll({ sshTarget: 'alice@example.test', password: PASSWORD }), (error) => error instanceof Error && 'code' in error && error.code === 'TOKEN_PARSE_FAILED' && !error.message.includes(TOKEN));
  assert.ok(subject.io.runs.some(({ args }) => (args.at(-1) ?? '').includes('grep -vxF')));
});

test('Given an enrolled tunnel exits, when supervised, then it restarts with key authentication and no askpass', async () => {
  const subject = fixture(); await subject.service.enroll({ sshTarget: 'alice@example.test', password: PASSWORD });
  subject.io.spawns[0]?.child.emit('exit', 255, null);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(subject.io.spawns.length, 2); assert.equal(subject.io.spawns[1]?.options.env?.SSH_ASKPASS, undefined); assert.ok(subject.io.spawns[1]?.args.includes('/hub/fleet/id_ed25519'));
});

test('Given a restarted tunnel remains healthy, when it exits later, then the restart budget and backoff are reset', async () => {
  type Task = { delay: number; callback: () => void; canceled: boolean };
  const tasks: Task[] = []; const io = new FakeIo(); const store = new MemoryStore();
  const manager = new SshTunnelManager({ io, store, maxRestartAttempts: 2, healthyResetMs: 30_000, paths: { directory: '/hub/fleet', privateKey: '/hub/fleet/id_ed25519', publicKey: '/hub/fleet/id_ed25519.pub', knownHosts: '/hub/fleet/known_hosts' }, scheduler: { schedule: (delay, callback) => { const task = { delay, callback, canceled: false }; tasks.push(task); return { cancel: () => { task.canceled = true; } }; } } });
  const service = new SshEasyEnrollService({ tunnels: manager, hubPairing: { enroll: async () => ({ peerId: PEER_ID }) } });
  await service.enroll({ sshTarget: 'alice@example.test', password: PASSWORD });
  io.spawns[0]?.child.emit('exit', 255, null); const firstRestart = tasks.find((task) => !task.canceled && task.delay === 1_000); assert.ok(firstRestart); firstRestart.callback(); await new Promise<void>((resolve) => setImmediate(resolve));
  const healthy = tasks.findLast((task) => !task.canceled && task.delay === 30_000); assert.ok(healthy); healthy.callback();
  io.spawns[1]?.child.emit('exit', 255, null);
  assert.equal(tasks.findLast((task) => !task.canceled)?.delay, 1_000);
});

test('Given an enrolled tunnel, when its peer is deleted, then the process group and authorized key are removed', async () => {
  const subject = fixture(); await subject.service.enroll({ sshTarget: 'alice@example.test', password: PASSWORD }); await subject.service.remove(PEER_ID);
  assert.deepEqual(subject.io.spawns[0]?.child.stopSignals, ['SIGTERM']); assert.equal(subject.store.findByPeerId(PEER_ID), undefined);
  const cleanup = subject.io.runs.find(({ args }) => (args.at(-1) ?? '').includes('grep -vxF')); assert.ok(cleanup);
  assert.match(cleanup.args.at(-1) ?? '', /authorized_keys/); assert.match(cleanup.args.at(-1) ?? '', /AAAATEST/);
});

test('Given no installed key for a target, when password is omitted, then enrollment requires one without spawning SSH', async () => {
  const subject = fixture(); const route = await startRoute(subject.service);
  try {
    const response = await fetch(`${route.url}/ssh-enroll`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sshTarget: 'alice@example.test' }) });
    assert.equal(response.status, 400); assert.equal(responseErrorCode(await response.json()), 'SSH_PASSWORD_REQUIRED');
  } finally { await route.close(); }
  assert.equal(subject.io.spawns.length, 0);
});

test('Given a hub supervisor disappears without stopping its master, when a new hub restores, then it reclaims the persisted control session with key-only authentication', async () => {
  const original = fixture(); await original.service.enroll({ sshTarget: 'alice@example.test:2222', password: PASSWORD });
  // Deliberately abandon `original.manager` without stop(): this models a hub crash
  // while the detached OpenSSH control master and durable record remain.
  const io = new FakeIo(); const restored = new SshTunnelManager({ io, store: original.store, paths: { directory: '/hub/fleet', privateKey: '/hub/fleet/id_ed25519', publicKey: '/hub/fleet/id_ed25519.pub', knownHosts: '/hub/fleet/known_hosts' }, scheduler: { schedule: () => ({ cancel: () => undefined }) } });
  await restored.restore();
  assert.ok(io.runs[0]?.args.includes('check'), 'restore classifies the persisted control session before reclaiming it'); assert.ok(io.runs[1]?.args.includes('exit')); assert.match(io.spawns[0]?.args.join(' ') ?? '', /127\.0\.0\.1:41234:127\.0\.0\.1:3001/);
  assert.equal(io.spawns[0]?.options.env?.SSH_ASKPASS, undefined); assert.ok(io.spawns[0]?.args.includes('BatchMode=yes'));
});

test('Given malformed credential JSON aliases in production middleware order, then no reporter sink receives the secret', async (context) => {
  const reports: unknown[] = []; const consoleReports: unknown[] = []; const subject = fixture(); const route = await startRoute(subject.service, reports); context.after(route.close);
  const originalConsoleError = console.error; console.error = (...values: unknown[]) => { consoleReports.push(values); }; context.after(() => { console.error = originalConsoleError; });
  const sentinel = 'MALFORMED-SSH-SECRET-9f4c';
  const origin = route.url.replace('/api/fleet', '');
  for (const url of [`${route.url}/ssh-enroll`, `${route.url}/ssh-enroll/`, `${origin}/API/FLEET/SSH-ENROLL`]) {
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: `{"sshTarget":"alice@example.test","password":"${sentinel}"` });
    const body = await response.text();
    assert.equal(response.status, 400); assert.equal(responseErrorCode(JSON.parse(body)), 'MALFORMED_REQUEST'); assert.equal(body.includes(sentinel), false);
  }
  assert.equal(JSON.stringify(reports).includes(sentinel), false); assert.equal(JSON.stringify(consoleReports).includes(sentinel), false); assert.deepEqual(reports, []);
});

test('Given token-like output is not one exact unique first line, when enrollment runs, then it is rejected closed', async () => {
  for (const stdout of [`banner\nPairing token: ${TOKEN}\n`, `Pairing token: ${TOKEN}\nPairing token: ${TOKEN}\n`]) {
    const subject = fixture([{ code: 0, stdout: '', stderr: '' }, { code: 0, stdout: '', stderr: '' }, { code: 0, stdout, stderr: '' }]);
    await assert.rejects(subject.service.enroll({ sshTarget: 'alice@example.test', password: PASSWORD }), (error) => error instanceof SshEnrollmentError && error.code === 'TOKEN_PARSE_FAILED');
  }
  const accepted = fixture([{ code: 0, stdout: '', stderr: '' }, { code: 0, stdout: '', stderr: '' }, { code: 0, stdout: `Pairing token: ${TOKEN}\nExpires later\n`, stderr: '' }]);
  assert.equal((await accepted.service.enroll({ sshTarget: 'alice@example.test', password: PASSWORD })).peerId, PEER_ID);
});

test('Given the tunnel exits before readiness, when preparing enrollment, then pairing never starts and key installation is compensated', async () => {
  const subject = fixture(); subject.io.ready = () => new Promise<void>(() => undefined); subject.io.onSpawn = (child) => queueMicrotask(() => child.emit('exit', 255, null));
  await assert.rejects(subject.service.enroll({ sshTarget: 'alice@example.test', password: PASSWORD }), (error) => error instanceof SshEnrollmentError && error.code === 'TUNNEL_FAILED');
  assert.equal(subject.enrollments.length, 0); assert.ok(subject.io.runs.some(({ args }) => (args.at(-1) ?? '').includes('grep -vxF')));
});

test('Given an allocated port collides with persisted metadata, when preparing a new target, then a different port is reserved', async () => {
  const subject = fixture(); subject.store.save({ peerId: 'other', sshTarget: 'bob@example.test', localPort: 41234 }); subject.io.allocatedPorts = [41234, 41235];
  const result = await subject.service.enroll({ sshTarget: 'alice@example.test', password: PASSWORD });
  assert.equal(result.port, 41235);
});

test('Given pairing rejects after the key and ready tunnel, when enrollment aborts, then the key is removed and no tunnel record persists', async () => {
  const io = new FakeIo(); const store = new MemoryStore(); const manager = new SshTunnelManager({ io, store, paths: { directory: '/hub/fleet', privateKey: '/hub/fleet/id_ed25519', publicKey: '/hub/fleet/id_ed25519.pub', knownHosts: '/hub/fleet/known_hosts' }, scheduler: { schedule: () => ({ cancel: () => undefined }) } });
  const service = new SshEasyEnrollService({ tunnels: manager, hubPairing: { enroll: async () => { throw new Error('rejected'); } } });
  await assert.rejects(service.enroll({ sshTarget: 'alice@example.test', password: PASSWORD }), (error) => error instanceof SshEnrollmentError && error.code === 'ENROLL_FAILED');
  assert.deepEqual(store.records, []); assert.ok(io.runs.some(({ args }) => (args.at(-1) ?? '').includes('grep -vxF')));
});

test('Given askpass helper creation fails after writing the password, then its private directory is removed', async () => {
  const subject = fixture(); subject.io.failWriteAt = 2;
  await assert.rejects(subject.service.enroll({ sshTarget: 'alice@example.test', password: PASSWORD }), (error) => error instanceof SshEnrollmentError && error.code === 'TUNNEL_FAILED');
  const payload = subject.io.writes[0]?.path; assert.ok(payload);
  await assert.rejects(stat(payload));
});

test('Given askpass directory cleanup throws, then key and master cleanup still run and the failure is reported', async () => {
  const subject = fixture(); subject.io.failRm = true;
  await assert.rejects(subject.service.enroll({ sshTarget: 'alice@example.test', password: PASSWORD }), (error) => error instanceof SshEnrollmentError && error.cleanupErrors.length > 0);
  assert.ok(subject.io.runs.some(({ args }) => (args.at(-1) ?? '').includes('authorized_keys')));
  assert.ok(subject.io.runs.some(({ args }) => args.includes('exit')));
});

test('Given remote key removal exits nonzero, then abort reports incomplete cleanup after exiting the master', async () => {
  const subject = fixture();
  subject.io.onRun = (_command, args) => args.at(-1) === 'chatmux-fleet-remove-key-v1' ? { code: 255, stdout: '', stderr: 'restricted command refused' } : undefined;
  const service = new SshEasyEnrollService({ tunnels: subject.manager, hubPairing: { enroll: async () => { throw new Error('persistence failed'); } } });
  await assert.rejects(service.enroll({ sshTarget: 'alice@example.test', password: PASSWORD }), (error) => error instanceof SshEnrollmentError && error.message.includes('cleanup was incomplete'));
  assert.ok(subject.io.runs.some(({ args }) => args.includes('exit')));
});

test('Given restore launch exits during readiness, then the failed child is stopped immediately', async () => {
  const io = new FakeIo(); io.ready = () => new Promise<void>(() => undefined); io.onSpawn = (child) => queueMicrotask(() => child.emit('exit', 255, null));
  const store = new MemoryStore(); store.save({ peerId: PEER_ID, sshTarget: 'alice@example.test', localPort: 41234 });
  const manager = new SshTunnelManager({ io, store, paths: { directory: '/hub/fleet', privateKey: '/hub/fleet/id_ed25519', publicKey: '/hub/fleet/id_ed25519.pub', knownHosts: '/hub/fleet/known_hosts' }, scheduler: { schedule: () => ({ cancel: () => undefined }) } });
  await manager.restore();
  assert.deepEqual(io.spawns[0]?.child.stopSignals, ['SIGTERM']);
});

test('Given tunnel abort throws after pairing succeeds, then pairing rollback still runs first and cleanup remains closed', async () => {
  const calls: string[] = [];
  const service = new SshEasyEnrollService({
    tunnels: { prepare: async () => ({ localPort: 41234, token: TOKEN, complete: () => { throw new Error('metadata failed'); }, abort: async () => { calls.push('abort'); throw new Error('abort failed'); } }), remove: async () => undefined, restore: async () => undefined, stop: () => undefined } as unknown as SshTunnelManager,
    hubPairing: { enroll: async () => ({ peerId: PEER_ID }), rollback: async () => { calls.push('rollback'); } },
  });
  await assert.rejects(service.enroll({ sshTarget: 'alice@example.test', password: PASSWORD }), (error) => error instanceof SshEnrollmentError && error.cleanupErrors.length === 1);
  assert.deepEqual(calls, ['rollback', 'abort']);
});

test('Given tunnel metadata save fails after peer persistence, when enrollment aborts, then completion remains compensatable and the peer is rolled back', async () => {
  const io = new FakeIo(); const store = new MemoryStore(); store.save = () => { throw new Error('duplicate local port'); };
  const manager = new SshTunnelManager({ io, store, paths: { directory: '/hub/fleet', privateKey: '/hub/fleet/id_ed25519', publicKey: '/hub/fleet/id_ed25519.pub', knownHosts: '/hub/fleet/known_hosts' }, scheduler: { schedule: () => ({ cancel: () => undefined }) } });
  const rolledBack: string[] = [];
  const service = new SshEasyEnrollService({ tunnels: manager, hubPairing: { enroll: async () => ({ peerId: PEER_ID }), rollback: (peerId) => { rolledBack.push(peerId); } } });
  await assert.rejects(service.enroll({ sshTarget: 'alice@example.test', password: PASSWORD }), (error) => error instanceof SshEnrollmentError && error.code === 'ENROLL_FAILED');
  assert.deepEqual(rolledBack, [PEER_ID]); assert.ok(io.runs.some(({ args }) => (args.at(-1) ?? '').includes('grep -vxF')));
});

test('Given a restart exits during readiness, then exactly one guarded retry is scheduled', async () => {
  type Task = { delay: number; callback: () => void; canceled: boolean };
  const tasks: Task[] = []; const io = new FakeIo(); const store = new MemoryStore();
  const manager = new SshTunnelManager({ io, store, paths: { directory: '/hub/fleet', privateKey: '/hub/fleet/id_ed25519', publicKey: '/hub/fleet/id_ed25519.pub', knownHosts: '/hub/fleet/known_hosts' }, scheduler: { schedule: (delay, callback) => { const task = { delay, callback, canceled: false }; tasks.push(task); return { cancel: () => { task.canceled = true; } }; } } });
  const service = new SshEasyEnrollService({ tunnels: manager, hubPairing: { enroll: async () => ({ peerId: PEER_ID }) } });
  await service.enroll({ sshTarget: 'alice@example.test', password: PASSWORD });
  io.spawns[0]?.child.emit('exit', 255, null);
  const firstRetry = tasks.find((task) => !task.canceled && task.delay === 1_000); assert.ok(firstRetry);
  io.ready = () => new Promise<void>(() => undefined); io.onSpawn = (child) => queueMicrotask(() => child.emit('exit', 255, null));
  firstRetry.canceled = true; firstRetry.callback(); await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(tasks.filter((task) => !task.canceled && task.delay < 30_000).map(({ delay }) => delay), [2_000]);
});

test('Given restore exits during readiness, then its record stays managed and its single retry respawns', async () => {
  type Task = { delay: number; callback: () => void; canceled: boolean };
  const tasks: Task[] = []; const io = new FakeIo(); const store = new MemoryStore(); store.save({ peerId: PEER_ID, sshTarget: 'alice@example.test', localPort: 41234 });
  io.ready = () => new Promise<void>(() => undefined); io.onSpawn = (child) => queueMicrotask(() => child.emit('exit', 255, null));
  const manager = new SshTunnelManager({ io, store, paths: { directory: '/hub/fleet', privateKey: '/hub/fleet/id_ed25519', publicKey: '/hub/fleet/id_ed25519.pub', knownHosts: '/hub/fleet/known_hosts' }, scheduler: { schedule: (delay, callback) => { const task = { delay, callback, canceled: false }; tasks.push(task); return { cancel: () => { task.canceled = true; } }; } } });
  await manager.restore();
  assert.deepEqual(io.spawns[0]?.child.stopSignals, ['SIGTERM']); assert.ok(store.findByPeerId(PEER_ID));
  const retries = tasks.filter((task) => !task.canceled && task.delay < 30_000); assert.equal(retries.length, 1);
  io.ready = async () => undefined; io.onSpawn = undefined; retries[0]?.callback(); await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(io.spawns.length, 2);
});

test('Given a live master refuses exit during restore, then spawn waits for a later successful reclaim', async () => {
  type Task = { callback: () => void; canceled: boolean };
  const tasks: Task[] = []; const io = new FakeIo(); const store = new MemoryStore(); store.save({ peerId: PEER_ID, sshTarget: 'alice@example.test', localPort: 41234 });
  io.runResults = [{ code: 0, stdout: '', stderr: '' }, { code: 255, stdout: '', stderr: 'exit refused' }];
  const manager = new SshTunnelManager({ io, store, paths: { directory: '/hub/fleet', privateKey: '/hub/fleet/id_ed25519', publicKey: '/hub/fleet/id_ed25519.pub', knownHosts: '/hub/fleet/known_hosts' }, scheduler: { schedule: (_delay, callback) => { const task = { callback, canceled: false }; tasks.push(task); return { cancel: () => { task.canceled = true; } }; } } });
  await manager.restore(); assert.equal(io.spawns.length, 0);
  const retry = tasks.find((task) => !task.canceled); assert.ok(retry); retry.callback(); await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(io.spawns.length, 1);
});

test('Given an existing stale control socket during restore, then it is removed and spawn proceeds only after the port is free', async () => {
  const io = new FakeIo(); const store = new MemoryStore(); store.save({ peerId: PEER_ID, sshTarget: 'alice@example.test', localPort: 41234 });
  const controlPath = '/hub/fleet/control-41234'; io.existingPaths.add(controlPath);
  io.runResults = [{ code: 255, stdout: '', stderr: 'Control socket connect: Connection refused' }];
  io.unavailable = async (port, path) => { assert.equal(port, 41234); assert.equal(path, controlPath); assert.equal(io.existingPaths.has(controlPath), false); };
  const manager = new SshTunnelManager({ io, store, paths: { directory: '/hub/fleet', privateKey: '/hub/fleet/id_ed25519', publicKey: '/hub/fleet/id_ed25519.pub', knownHosts: '/hub/fleet/known_hosts' }, scheduler: { schedule: () => ({ cancel: () => undefined }) } });
  await manager.restore(); assert.deepEqual(io.removals, [controlPath]); assert.equal(io.unavailableCalls, 1); assert.equal(io.spawns.length, 1);
});

test('Given stale socket reclamation leaves the enrollment port occupied, then preparation returns a closed failure without spawning', async () => {
  const subject = fixture([
    { code: 0, stdout: '', stderr: '' },
    { code: 0, stdout: '', stderr: '' },
    { code: 0, stdout: `Pairing token: ${TOKEN}\n`, stderr: '' },
    { code: 255, stdout: '', stderr: 'Control socket connect: Connection refused' },
  ]);
  const controlPath = '/hub/fleet/control-41234'; subject.io.existingPaths.add(controlPath);
  subject.io.unavailable = async () => { throw new Error('local tunnel port remains occupied'); };
  await assert.rejects(subject.manager.prepare({ sshTarget: 'alice@example.test', password: PASSWORD }), (error) => error instanceof SshEnrollmentError && error.code === 'TUNNEL_FAILED');
  assert.deepEqual(subject.io.removals.filter((path) => path === controlPath), [controlPath]); assert.equal(subject.io.spawns.length, 0); assert.equal(subject.io.unavailableCalls, 1);
});

test('Given a live master exits cleanly but the port stays occupied, then the sentinel cleanup path removes the installed key', async () => {
  const subject = fixture();
  subject.io.unavailable = async () => { throw new Error('local tunnel port remains occupied'); };
  await assert.rejects(subject.manager.prepare({ sshTarget: 'alice@example.test', password: PASSWORD }), (error) => error instanceof SshEnrollmentError && error.code === 'TUNNEL_FAILED');
  const removalRuns = subject.io.runs.filter(({ args }) => args.at(-1) === 'chatmux-fleet-remove-key-v1');
  assert.equal(removalRuns.length, 1, 'exactly one sentinel key removal after the master exited');
  const installRun = subject.io.runs.find(({ args }) => (args.at(-1) ?? '').includes("printf '%s\\n'"));
  assert.ok(installRun, 'key installation command ran');
  assert.ok((installRun?.args.at(-1) ?? '').includes('SSH_ORIGINAL_COMMAND'), 'the installed entry carries the sentinel forced command that the occupied-port cleanup path executes');
  assert.equal(subject.io.spawns.length, 0);
});

test('Given a reclaimed stale socket leaves its port occupied, then restore fails closed without spawning', async () => {
  const io = new FakeIo(); const store = new MemoryStore(); store.save({ peerId: PEER_ID, sshTarget: 'alice@example.test', localPort: 41234 });
  const controlPath = '/hub/fleet/control-41234'; io.existingPaths.add(controlPath); io.runResults = [{ code: 255, stdout: '', stderr: 'Control socket connect: Connection refused' }];
  io.unavailable = async () => { throw new Error('SSH control session did not terminate'); };
  let retries = 0;
  const manager = new SshTunnelManager({ io, store, paths: { directory: '/hub/fleet', privateKey: '/hub/fleet/id_ed25519', publicKey: '/hub/fleet/id_ed25519.pub', knownHosts: '/hub/fleet/known_hosts' }, scheduler: { schedule: () => { retries += 1; return { cancel: () => undefined }; } } });
  await manager.restore(); assert.deepEqual(io.removals, [controlPath]); assert.equal(io.unavailableCalls, 2); assert.equal(io.spawns.length, 0); assert.equal(retries, 1);
});

test('Given reconciliation throws after persistence, then enrollment remains committed and managed while reconciliation is retried', async () => {
  const io = new FakeIo(); const store = new MemoryStore(); const manager = new SshTunnelManager({ io, store, paths: { directory: '/hub/fleet', privateKey: '/hub/fleet/id_ed25519', publicKey: '/hub/fleet/id_ed25519.pub', knownHosts: '/hub/fleet/known_hosts' }, scheduler: { schedule: () => ({ cancel: () => undefined }) } });
  let attempts = 0; let reports = 0; let retry: (() => void) | undefined;
  const service = new SshEasyEnrollService({ tunnels: manager, onPersisted: () => { attempts += 1; if (attempts === 1) throw new Error('reconcile failed'); }, reportPostCommitFailure: () => { reports += 1; }, schedulePostCommitRetry: (callback) => { retry = callback; }, hubPairing: { enroll: async () => ({ peerId: PEER_ID }) } });
  assert.deepEqual(await service.enroll({ sshTarget: 'alice@example.test', password: PASSWORD }), { peerId: PEER_ID, port: 41234 });
  assert.ok(store.findByPeerId(PEER_ID)); assert.deepEqual(io.spawns[0]?.child.stopSignals, []); assert.equal(reports, 1); assert.equal(attempts, 1);
  assert.ok(retry); retry(); await new Promise<void>((resolve) => setImmediate(resolve)); assert.equal(attempts, 2);
});

test('Given pairing cleanup failed after redemption, then the SSH closed error preserves cleanup diagnostics', async () => {
  const prepared = { localPort: 41234, token: TOKEN, complete: () => undefined, abort: async () => undefined };
  const service = new SshEasyEnrollService({ tunnels: { prepare: async () => prepared } as unknown as SshTunnelManager, hubPairing: { enroll: async () => { throw new FleetHubPairingError('PEER_IDENTITY_INVALID', 'invalid identity', [new Error('remote revoke refused')]); } } });
  await assert.rejects(service.enroll({ sshTarget: 'alice@example.test', password: PASSWORD }), (error) => error instanceof SshEnrollmentError && error.code === 'ENROLL_FAILED' && error.message.includes('cleanup was incomplete') && error.cleanupErrors[0]?.message === 'remote revoke refused');
});

test('Given the tunnel key is installed, then OpenSSH parses its forced command and multiplexed cleanup uses the same sentinel', async (context) => {
  const local = await mkdtemp(join(tmpdir(), 'chatmux-key-protocol-')); const remote = await mkdtemp(join(tmpdir(), 'chatmux-key-remote-'));
  context.after(() => Promise.all([rm(local, { recursive: true, force: true }), rm(remote, { recursive: true, force: true })]));
  const generated = spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'chatmux-fleet-tunnel', '-f', join(local, 'id')]); assert.equal(generated.status, 0);
  const io = new FakeIo(); io.readFile = async () => readFile(join(local, 'id.pub'), 'utf8'); const store = new MemoryStore();
  const manager = new SshTunnelManager({ io, store, paths: { directory: '/hub/fleet', privateKey: '/hub/fleet/id_ed25519', publicKey: '/hub/fleet/id_ed25519.pub', knownHosts: '/hub/fleet/known_hosts' }, scheduler: { schedule: () => ({ cancel: () => undefined }) } });
  const service = new SshEasyEnrollService({ tunnels: manager, hubPairing: { enroll: async () => ({ peerId: PEER_ID }) } });
  await service.enroll({ sshTarget: 'alice@example.test', password: PASSWORD }); await manager.remove(PEER_ID);
  const install = io.runs.find(({ args }) => (args.at(-1) ?? '').includes("printf '%s\\n'"))?.args.at(-1) ?? ''; const cleanup = io.runs.find(({ args }) => args.at(-1) === 'chatmux-fleet-remove-key-v1');
  assert.match(install, /command=".*SSH_ORIGINAL_COMMAND.*chatmux-fleet-remove-key-v1/); assert.ok(cleanup?.args.includes('ControlPath=/hub/fleet/control-41234'));
  assert.match(install, /permitopen="127\.0\.0\.1:3001"/); assert.match(install, /printf '%s\\n' 'command=/);
  const installed = spawnSync('/bin/sh', ['-c', install], { env: { ...process.env, HOME: remote } }); assert.equal(installed.status, 0, installed.stderr.toString());
  const authorizedKeys = join(remote, '.ssh', 'authorized_keys'); const parsed = spawnSync('ssh-keygen', ['-l', '-f', authorizedKeys]); assert.equal(parsed.status, 0, parsed.stderr.toString());
  const originalEntry = await readFile(authorizedKeys, 'utf8');
  const forcedMatch = /^command="((?:\\.|[^"\\])*)",restrict/.exec(originalEntry); assert.ok(forcedMatch?.[1]);
  const forcedCommand = forcedMatch[1].replace(/\\(["\\])/g, '$1');
  const syntax = spawnSync('/bin/sh', ['-n', '-c', forcedCommand], { encoding: 'utf8' }); assert.equal(syntax.status, 0, syntax.stderr);
  const denied = spawnSync('/bin/sh', ['-c', forcedCommand], { env: { ...process.env, HOME: remote, SSH_ORIGINAL_COMMAND: 'anything-else' }, encoding: 'utf8' });
  assert.equal(denied.status, 126, denied.stderr); assert.equal(await readFile(authorizedKeys, 'utf8'), originalEntry);
  const removed = spawnSync('/bin/sh', ['-c', forcedCommand], { env: { ...process.env, HOME: remote, SSH_ORIGINAL_COMMAND: 'chatmux-fleet-remove-key-v1' }, encoding: 'utf8' });
  assert.equal(removed.status, 0, removed.stderr); assert.equal(await readFile(authorizedKeys, 'utf8'), '');

  const reinstalled = spawnSync('/bin/sh', ['-c', install], { env: { ...process.env, HOME: remote } }); assert.equal(reinstalled.status, 0, reinstalled.stderr.toString());
  const compensationIo = new FakeIo(); compensationIo.readFile = io.readFile;
  compensationIo.runResults = [{ code: 0, stdout: '', stderr: '' }, { code: 0, stdout: '', stderr: '' }, { code: 127, stdout: '', stderr: 'command not found' }];
  const compensationManager = new SshTunnelManager({ io: compensationIo, store: new MemoryStore(), paths: { directory: '/hub/fleet', privateKey: '/hub/fleet/id_ed25519', publicKey: '/hub/fleet/id_ed25519.pub', knownHosts: '/hub/fleet/known_hosts' }, scheduler: { schedule: () => ({ cancel: () => undefined }) } });
  await assert.rejects(compensationManager.prepare({ sshTarget: 'alice@example.test', password: PASSWORD }));
  const compensation = compensationIo.runs.find(({ args }) => (args.at(-1) ?? '').includes('authorized_keys') && !(args.at(-1) ?? '').includes("printf '%s\\n'"))?.args.at(-1); assert.ok(compensation);
  const compensated = spawnSync('/bin/sh', ['-c', compensation], { env: { ...process.env, HOME: remote }, encoding: 'utf8' }); assert.equal(compensated.status, 0, compensated.stderr);
  assert.equal(await readFile(authorizedKeys, 'utf8'), '');
});

test('Given a remote install command exits after authentication and writing the key, then the live master and key are conservatively unwound', async () => {
  const subject = fixture();
  subject.io.onRun = (_command, args) => (args.at(-1) ?? '').includes("printf '%s\\n'")
    ? { code: 1, stdout: '', stderr: 'later install step failed' }
    : undefined;
  await assert.rejects(subject.service.enroll({ sshTarget: 'alice@example.test', password: PASSWORD }), (error) => error instanceof SshEnrollmentError && error.code === 'TUNNEL_FAILED');
  assert.equal(subject.io.spawns.length, 0);
  assert.ok(subject.io.runs.some(({ args }) => (args.at(-1) ?? '').includes('authorized_keys') && !(args.at(-1) ?? '').includes("printf '%s\\n'")), 'possibly written key is removed');
  assert.ok(subject.io.runs.some(({ args }) => args.includes('exit')), 'authenticated master is reclaimed');
});

test('Given token minting fails after key installation, then only the installed key and existing master are unwound', async () => {
  const subject = fixture([{ code: 0, stdout: '', stderr: '' }, { code: 0, stdout: '', stderr: '' }, { code: 127, stdout: '', stderr: 'command not found' }]);
  await assert.rejects(subject.service.enroll({ sshTarget: 'alice@example.test', password: PASSWORD }), (error) => error instanceof SshEnrollmentError && error.code === 'REMOTE_CLI_FAILED' && error.cleanupErrors.length === 0);
  assert.equal(subject.io.spawns.length, 0); assert.ok(subject.io.runs.some(({ args }) => (args.at(-1) ?? '').includes('authorized_keys'))); assert.ok(subject.io.runs.some(({ args }) => args.includes('exit')));
});

test('Given genuine mid-flow cleanup failure, then diagnostics attach without replacing the original closed code', async () => {
  const subject = fixture([
    { code: 0, stdout: '', stderr: '' },
    { code: 0, stdout: '', stderr: '' },
    { code: 127, stdout: '', stderr: 'command not found' },
    { code: 255, stdout: '', stderr: 'key cleanup refused' },
  ]);
  await assert.rejects(subject.service.enroll({ sshTarget: 'alice@example.test', password: PASSWORD }), (error) => error instanceof SshEnrollmentError && error.code === 'REMOTE_CLI_FAILED' && error.message.includes('cleanup was incomplete') && error.cleanupErrors.length === 1);
});
