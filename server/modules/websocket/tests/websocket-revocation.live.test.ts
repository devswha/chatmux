import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import express from 'express';
import WebSocket from 'ws';

const directory = await mkdtemp(path.join(tmpdir(), 'chatmux-ws-revocation-'));
const previousDatabase = process.env.DATABASE_PATH;
const previousMode = process.env.CHATMUX_AUTH;
process.env.DATABASE_PATH = path.join(directory, 'auth.db');
process.env.CHATMUX_AUTH = 'password';
// Auth owns a module-load JWT secret: isolate the database before importing it.
const { closeConnection, initializeDatabase, userDb, sessionsDb } = await import('@/modules/database/index.js');
const { authenticateWebSocket, generateToken, incrementTokenVersion } = await import('@/middleware/auth.js');
// eslint-disable-next-line boundaries/no-unknown -- integration test exercises the real legacy HTTP logout entry point.
const { default: authRoutes } = await import('@/routes/auth.js');
const { createWebSocketServer } = await import('../services/websocket-server.service.js');
await initializeDatabase();
const owner = userDb.createUser('revocation-owner', 'unused-test-hash');

after(async () => {
  closeConnection();
  if (previousDatabase === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previousDatabase;
  if (previousMode === undefined) delete process.env.CHATMUX_AUTH; else process.env.CHATMUX_AUTH = previousMode;
  await rm(directory, { recursive: true, force: true });
});

type GatewayOptions = {
  authenticate?: Parameters<typeof createWebSocketServer>[1]['verifyClient']['authenticateWebSocket'];
  guard?: Parameters<typeof createWebSocketServer>[1]['chat']['findLiveTmuxSpawnBlock'];
};
async function gateway(options: GatewayOptions = {}) {
  const app = express();
  app.use('/api/auth', authRoutes);
  const server = createServer(app);
  const approvals: string[] = [];
  let onApproval = (): void => undefined;
  let spawned = 0;
  const spawn = async (): Promise<void> => { spawned += 1; };
  const abort = (): boolean => false;
  const wss = createWebSocketServer(server, {
    verifyClient: { authenticateWebSocket: options.authenticate ?? authenticateWebSocket },
    chat: {
      spawnFns: { claude: spawn, codex: spawn, cursor: spawn, opencode: spawn, gjc: spawn, omp: spawn, omo: spawn },
      abortFns: { claude: abort, codex: abort, cursor: abort, opencode: abort, gjc: abort, omp: abort, omo: abort },
      resolveToolApproval: (id) => { approvals.push(id); onApproval(); },
      getPendingApprovalsForSession: () => [],
      ...(options.guard === undefined ? {} : { findLiveTmuxSpawnBlock: options.guard }),
    },
    shell: {
      resolveProviderSessionId: () => null, stripAnsiSequences: (value) => value,
      normalizeDetectedUrl: () => null, extractUrlsFromText: () => [], shouldAutoOpenUrlFromOutput: () => false,
    },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
  const cookie = `chatmux_auth=${generateToken(owner)}`;
  const connected = once(wss, 'connection');
  const client = new WebSocket(`${url.replace('http:', 'ws:')}/ws`, { headers: { Cookie: cookie } });
  const [socket] = await connected as [WebSocket];
  await once(client, 'open');
  return {
    url, cookie, client, socket, approvals,
    spawned: () => spawned,
    onApproval: (callback: () => void) => { onApproval = callback; },
    close: async () => {
      client.terminate();
      for (const connection of wss.clients) connection.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

test('logout revokes an already-open WebSocket before another approval can dispatch', { timeout: 10_000 }, async (t) => {
  const fixture = await gateway();
  t.after(fixture.close);
  const outcome = new Promise<string>((resolve) => {
    fixture.client.once('close', () => resolve('closed'));
    fixture.onApproval(() => resolve('dispatched'));
  });
  const response = await fetch(`${fixture.url}/api/auth/logout`, { method: 'POST', headers: { Cookie: fixture.cookie } });
  assert.equal(response.status, 200);
  if (fixture.client.readyState === WebSocket.OPEN) fixture.client.send(JSON.stringify({ type: 'chat.permission-response', requestId: 'revoked-approval', allow: true }));
  assert.equal(await outcome, 'closed');
  assert.deepEqual(fixture.approvals, []);
});

test('a revoked open socket cannot receive subsequently published output', { timeout: 10_000 }, async (t) => {
  const fixture = await gateway();
  t.after(fixture.close);
  const outcome = new Promise<string>((resolve) => {
    fixture.client.once('close', () => resolve('closed'));
    fixture.client.once('message', () => resolve('output'));
  });
  incrementTokenVersion(owner.id);
  fixture.socket.send('private-output-after-revocation');
  assert.equal(await outcome, 'closed');
});

test('role changes and unavailable auth state close an admitted connection', { timeout: 10_000 }, async (t) => {
  for (const failure of ['role', 'store'] as const) {
    let changed = false;
    const fixture = await gateway({ authenticate: () => {
      if (changed && failure === 'store') throw new Error('auth store unavailable');
      return { userId: String(owner.id), username: owner.username, tailscaleRole: changed ? 'member' : 'owner' };
    } });
    t.after(fixture.close);
    const before = once(fixture.client, 'message');
    fixture.socket.send('authorized output');
    assert.equal(String((await before)[0]), 'authorized output');
    const closed = once(fixture.client, 'close');
    changed = true;
    fixture.socket.send('must not be published');
    assert.equal((await closed)[0], 1008);
  }
});

test('logout while fresh discovery is pending cannot start a provider afterward', { timeout: 10_000 }, async (t) => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<{ kind: 'clear' }>();
  sessionsDb.createSession('revocation-pending-session', 'codex', directory);
  const fixture = await gateway({ guard: () => { entered.resolve(); return release.promise; } });
  t.after(fixture.close);
  fixture.client.send(JSON.stringify({ type: 'chat.send', sessionId: 'revocation-pending-session', content: 'continue' }));
  await entered.promise;
  const closed = once(fixture.client, 'close');
  incrementTokenVersion(owner.id);
  release.resolve({ kind: 'clear' });
  await closed;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(fixture.spawned(), 0);
});
