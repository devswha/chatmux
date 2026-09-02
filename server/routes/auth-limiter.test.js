import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

const databaseDirectory = await mkdtemp(path.join(os.tmpdir(), 'chatmux-auth-limiter-'));
const previousDatabasePath = process.env.DATABASE_PATH;
const previousAuthMode = process.env.CHATMUX_AUTH;
process.env.DATABASE_PATH = path.join(databaseDirectory, 'auth.db');
process.env.CHATMUX_AUTH = 'password';
const [{ default: authRoutes }, database] = await Promise.all([
  import('./auth.js'),
  import('../modules/database/index.js'),
]);
const { closeConnection, initializeDatabase } = database;
await initializeDatabase();

test('login blocks an IP and username after ten failed attempts', async (t) => {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRoutes);
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const login = () => fetch(`http://127.0.0.1:${port}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'unknown-user', password: 'wrong-password' }),
  });

  t.after(async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    if (previousAuthMode === undefined) delete process.env.CHATMUX_AUTH;
    else process.env.CHATMUX_AUTH = previousAuthMode;
    await rm(databaseDirectory, { recursive: true, force: true });
  });

  for (let attempt = 0; attempt < 10; attempt += 1) {
    assert.equal((await login()).status, 401);
  }

  const blocked = await login();
  assert.equal(blocked.status, 429);
  assert.match(blocked.headers.get('retry-after') ?? '', /^\d+$/);
});

test('a forwarded-for header cannot rotate past the lockout under trust proxy', async (t) => {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  app.use('/api/auth', authRoutes);
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  // Connect from 127.0.0.2 so the server sees a non-loopback-looking direct
  // peer (Linux binds the whole 127/8 range to lo): forwarded headers from
  // such a client are its own to forge and must be ignored.
  const login = (forwardedFor) => new Promise((resolve, reject) => {
    const body = JSON.stringify({ username: 'rotating-user', password: 'wrong-password' });
    const request = httpRequest({
      host: '127.0.0.1', port, path: '/api/auth/login', method: 'POST', localAddress: '127.0.0.2',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'X-Forwarded-For': forwardedFor },
    }, (response) => { response.resume(); response.on('end', () => resolve({ status: response.statusCode })); });
    request.on('error', reject);
    request.end(body);
  });
  t.after(async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  for (let attempt = 0; attempt < 10; attempt += 1) {
    assert.equal((await login(`203.0.113.${attempt}`)).status, 401);
  }
  const blocked = await login('203.0.113.250');
  assert.equal(blocked.status, 429, 'the socket address is the key, not the spoofable req.ip');
});
