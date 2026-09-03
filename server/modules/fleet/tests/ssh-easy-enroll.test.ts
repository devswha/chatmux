import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';

import express from 'express';

import { createFleetPairingRouter } from '@/modules/fleet/fleet-pairing.routes.js';
import { FleetPairingFailureLimiter } from '@/modules/fleet/services/fleet-pairing-limiter.service.js';
import { SshEasyEnrollService } from '@/modules/fleet/services/ssh-easy-enroll.service.js';
import {
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
  private tempCount = 0;
  allocatePort = async (): Promise<number> => 41234;
  fileExists = async (): Promise<boolean> => this.keyExists;
  mkdir = async (): Promise<void> => undefined;
  mkdtemp = async (): Promise<string> => `/tmp/chatmux-askpass-${this.tempCount += 1}`;
  readFile = async (): Promise<string> => 'ssh-ed25519 AAAATEST chatmux-fleet-tunnel\n';
  writeFile = async (path: string, data: string, mode: number): Promise<void> => { this.writes.push({ path, data, mode }); };
  rm = async (path: string): Promise<void> => { this.removals.push(path); };
  run = async (command: string, args: readonly string[], options: SshProcessOptions): Promise<SshRunResult> => {
    this.runs.push({ command, args, options });
    return this.runResults.shift() ?? { code: 0, stdout: `Pairing token: ${TOKEN}\nExpires at: 2030-01-01T00:00:00.000Z\n`, stderr: '' };
  };
  spawn = (command: string, args: readonly string[], options: SshProcessOptions): SshProcess => {
    const child = new FakeProcess(); this.spawns.push({ command, args, options, child }); return child;
  };
  killGroup = (pid: number, signal: NodeJS.Signals): void => { this.spawns.find(({ child }) => child.pid === pid)?.child.stop(signal); };
}

type Fixture = Readonly<{ io: FakeIo; store: MemoryStore; manager: SshTunnelManager; service: SshEasyEnrollService; enrollments: Readonly<Record<string, unknown>>[] }>;
function responseErrorCode(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || !('error' in value)) return undefined;
  const error = value.error;
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}
function fixture(runResults: SshRunResult[] = []): Fixture {
  const io = new FakeIo(); io.runResults = [...runResults]; const store = new MemoryStore();
  const manager = new SshTunnelManager({ io, store, paths: { directory: '/hub/fleet', privateKey: '/hub/fleet/id_ed25519', publicKey: '/hub/fleet/id_ed25519.pub', knownHosts: '/hub/fleet/known_hosts' }, scheduler: { schedule: (_delay, callback) => { callback(); return { cancel: () => undefined }; } } });
  const enrollments: Readonly<Record<string, unknown>>[] = [];
  const service = new SshEasyEnrollService({ tunnels: manager, hubPairing: { enroll: async (input) => { enrollments.push(input); return { peerId: PEER_ID }; } } });
  return { io, store, manager, service, enrollments };
}

async function startRoute(subject: SshEasyEnrollService): Promise<Readonly<{ url: string; close(): Promise<void> }>> {
  const app = express(); app.use(express.json()); app.use((request, _response, next) => { Object.defineProperty(request, 'user', { value: { id: 1 } }); next(); });
  app.use('/api/fleet', createFleetPairingRouter({ authMode: 'password', limiter: new FleetPairingFailureLimiter(), pairing: { issueToken: () => ({ token: TOKEN, expiresAtMs: 1 }), redeem: () => { throw new TypeError('unused'); }, revokeHubGrant: () => false }, hubPairing: { enroll: async () => ({ peerId: PEER_ID }) }, revocation: { remove: async () => ({ localRemoval: 'removed', peerRevocation: 'revoked' }) }, sshEnrollment: subject }));
  const server = createServer(app); await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (address === null || typeof address === 'string') throw new TypeError('server address unavailable');
  return { url: `http://127.0.0.1:${address.port}/api/fleet`, close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}

test('Given an SSH host and password, when the owner enrolls it, then the stable loopback peer is enrolled without exposing credentials', async (context) => {
  const subject = fixture([{ code: 0, stdout: '', stderr: '' }, { code: 0, stdout: `Pairing token: ${TOKEN}\nExpires at: 2030-01-01T00:00:00.000Z\n`, stderr: '' }]); const route = await startRoute(subject.service); context.after(route.close);
  const response = await fetch(`${route.url}/ssh-enroll`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sshTarget: 'alice@example.test:2222', password: PASSWORD, label: ' Lab ' }) });
  const responseBody = await response.text(); assert.equal(response.status, 201); assert.deepEqual(JSON.parse(responseBody), { peerId: PEER_ID, port: 41234 });
  assert.deepEqual(subject.enrollments, [{ peerUrl: 'ws://127.0.0.1:41234/fleet-ws', transportMode: 'ssh-loopback', token: TOKEN, label: 'Lab' }]);
  const tunnel = subject.io.spawns[0]; assert.ok(tunnel); assert.deepEqual(tunnel.args, ['-N', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'UserKnownHostsFile=/hub/fleet/known_hosts', '-i', '/hub/fleet/id_ed25519', '-p', '2222', '-L', '127.0.0.1:41234:127.0.0.1:3001', 'alice@example.test']);
  assert.equal(tunnel.options.env?.SSH_ASKPASS, '/tmp/chatmux-askpass-1/askpass'); assert.equal(tunnel.options.env?.SSH_ASKPASS_REQUIRE, 'force');
  assert.deepEqual(subject.io.writes.map(({ mode }) => mode), [0o600, 0o600]); assert.deepEqual(subject.io.removals, ['/tmp/chatmux-askpass-2', '/tmp/chatmux-askpass-1']);
  assert.equal(JSON.stringify({ runs: subject.io.runs.map(({ command }) => command), body: responseBody }).includes(PASSWORD), false);
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
  assert.deepEqual(subject.io.removals, ['/tmp/chatmux-askpass-2', '/tmp/chatmux-askpass-1']);
});

test('Given an unreachable SSH server, when enrollment runs, then it reports SSH_UNREACHABLE', async () => {
  const subject = fixture([{ code: 255, stdout: '', stderr: 'ssh: connect to host example.test port 22: Connection timed out' }]);
  await assert.rejects(subject.service.enroll({ sshTarget: 'alice@example.test', password: PASSWORD }), (error) => error instanceof Error && 'code' in error && error.code === 'SSH_UNREACHABLE');
});

test('Given both remote CLI paths are missing, when minting runs, then it reports REMOTE_CLI_FAILED', async () => {
  const missing = { code: 127, stdout: '', stderr: 'command not found' }; const subject = fixture([{ code: 0, stdout: '', stderr: '' }, missing, missing]);
  await assert.rejects(subject.service.enroll({ sshTarget: 'alice@example.test', password: PASSWORD }), (error) => error instanceof Error && 'code' in error && error.code === 'REMOTE_CLI_FAILED');
});

test('Given malformed token output, when minting runs, then no token content reaches the error', async () => {
  const leaked = `Pairing token: ${TOKEN}extra`; const subject = fixture([{ code: 0, stdout: '', stderr: '' }, { code: 0, stdout: leaked, stderr: '' }]);
  await assert.rejects(subject.service.enroll({ sshTarget: 'alice@example.test', password: PASSWORD }), (error) => error instanceof Error && 'code' in error && error.code === 'TOKEN_PARSE_FAILED' && !error.message.includes(TOKEN));
});

test('Given an enrolled tunnel exits, when supervised, then it restarts with key authentication and no askpass', async () => {
  const subject = fixture([{ code: 0, stdout: '', stderr: '' }]); await subject.service.enroll({ sshTarget: 'alice@example.test', password: PASSWORD });
  subject.io.spawns[0]?.child.emit('exit', 255, null);
  assert.equal(subject.io.spawns.length, 2); assert.equal(subject.io.spawns[1]?.options.env?.SSH_ASKPASS, undefined); assert.ok(subject.io.spawns[1]?.args.includes('/hub/fleet/id_ed25519'));
});

test('Given an enrolled tunnel, when its peer is deleted, then the process group and authorized key are removed', async () => {
  const subject = fixture([{ code: 0, stdout: '', stderr: '' }]); await subject.service.enroll({ sshTarget: 'alice@example.test', password: PASSWORD }); await subject.service.remove(PEER_ID);
  assert.deepEqual(subject.io.spawns[0]?.child.stopSignals, ['SIGTERM']); assert.equal(subject.store.findByPeerId(PEER_ID), undefined);
  assert.match(subject.io.runs.at(-1)?.args.at(-1) ?? '', /authorized_keys/); assert.match(subject.io.runs.at(-1)?.args.at(-1) ?? '', /AAAATEST/);
});

test('Given no installed key for a target, when password is omitted, then enrollment requires one without spawning SSH', async () => {
  const subject = fixture(); const route = await startRoute(subject.service);
  try {
    const response = await fetch(`${route.url}/ssh-enroll`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sshTarget: 'alice@example.test' }) });
    assert.equal(response.status, 400); assert.equal(responseErrorCode(await response.json()), 'SSH_PASSWORD_REQUIRED');
  } finally { await route.close(); }
  assert.equal(subject.io.spawns.length, 0);
});

test('Given a persisted tunnel, when the hub starts, then its stable port is restored with key-only authentication', async () => {
  const subject = fixture(); subject.store.save({ peerId: PEER_ID, sshTarget: 'alice@example.test:2222', sshPort: 2222, localPort: 45678 });
  await subject.manager.restore();
  assert.match(subject.io.spawns[0]?.args.join(' ') ?? '', /127\.0\.0\.1:45678:127\.0\.0\.1:3001/); assert.equal(subject.io.spawns[0]?.options.env?.SSH_ASKPASS, undefined);
});
