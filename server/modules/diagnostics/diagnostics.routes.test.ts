import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import express from 'express';
import type { RequestHandler } from 'express';

import { createDiagnosticsRouter } from './diagnostics.routes.js';
import { createDiagnosticsService, type DiagnosticsDependencies } from './diagnostics.service.js';

async function fixture(options: {
  authMode?: 'none' | 'password' | 'tailscale';
  remoteAddress?: string;
  fail?: boolean;
  indexing?: DiagnosticsDependencies['indexing'];
} = {}) {
  let reads = 0;
  let indexingReads = 0;
  const app = express();
  const authenticate: RequestHandler = (request, response, next) => {
    if (request.headers['x-test-auth'] === 'rejected') {
      response.status(401).json({ error: 'authentication_required' });
      return;
    }
    if (request.headers['x-test-auth']) {
      Object.defineProperty(request, 'user', { value: {
        id: 1, tailscaleRole: request.headers['x-test-auth'],
      } });
    }
    if (options.remoteAddress) Object.defineProperty(request.socket, 'remoteAddress', { value: options.remoteAddress });
    next();
  };
  const service = createDiagnosticsService({
    collector: () => null, watcher: () => null, eventLoopUtilization: () => 0.2,
    indexing: () => { indexingReads++; return options.indexing?.(); },
  });
  app.use('/api/settings/diagnostics', createDiagnosticsRouter({
    authMode: options.authMode ?? 'tailscale', authenticate,
    read: () => {
      reads++;
      if (options.fail) throw new Error('PRIVATE_ERROR /home/private/token');
      return service.read();
    },
  }));
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    url: `http://127.0.0.1:${address.port}/api/settings/diagnostics`,
    reads: () => reads,
    indexingReads: () => indexingReads,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

test('unauthenticated and non-owner reads fail closed with no-store before collecting data', async (context) => {
  const subject = await fixture();
  context.after(subject.close);
  for (const [role, status] of [['', 401], ['rejected', 401], ['user', 403], ['member', 403]] as const) {
    const response = await fetch(`${subject.url}?owner=true&refresh=true`, {
      headers: { 'x-test-auth': role, 'x-forwarded-for': '127.0.0.1' },
    });
    assert.equal(response.status, status);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), { error: status === 401 ? 'authentication_required' : 'owner_required' });
  }
  assert.equal(subject.reads(), 0);
  assert.equal(subject.indexingReads(), 0);
});

test('Tailscale owner/local and password principals may read a bounded summary', async (context) => {
  for (const authMode of ['tailscale', 'password'] as const) {
    const subject = await fixture({ authMode });
    context.after(subject.close);
    for (const role of ['owner', 'local']) {
      const response = await fetch(subject.url, { headers: { 'x-test-auth': role } });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      const body = await response.text();
      assert.equal(JSON.parse(body).schemaVersion, 1);
      assert.doesNotMatch(body, /PRIVATE|socketPath|transcriptPaths|providerSessionId|password|token/);
    }
  }
});

test('implicit ownership requires actual loopback and ignores forwarded address claims', async (context) => {
  for (const [remoteAddress, status] of [['127.0.0.1', 200], ['::1', 200], ['100.64.0.9', 403]] as const) {
    const subject = await fixture({ authMode: 'none', remoteAddress });
    context.after(subject.close);
    const response = await fetch(subject.url, { headers: { 'x-test-auth': 'local', 'x-forwarded-for': '127.0.0.1' } });
    assert.equal(response.status, status);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(subject.reads(), status === 200 ? 1 : 0);
    await response.body?.cancel();
  }
});

test('unexpected summary errors return generic 503 without private diagnostics', async (context) => {
  const subject = await fixture({ fail: true });
  context.after(subject.close);
  const response = await fetch(subject.url, { headers: { 'x-test-auth': 'owner' } });
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { error: 'diagnostics_unavailable' });
});

test('there is no mutation or restart API', async (context) => {
  const subject = await fixture();
  context.after(subject.close);
  for (const method of ['POST', 'PUT', 'DELETE']) {
    const response = await fetch(subject.url, { method, headers: { 'x-test-auth': 'owner' } });
    assert.equal(response.status, 404);
    await response.body?.cancel();
  }
  assert.equal(subject.reads(), 0);
});


test('owner API exposes only bounded indexing counters from the shared cache', async (context) => {
  const source = {
    pending: 64, active: 4, maxPending: 448, maxActive: 4,
    reconciling: 2, reconciliationPending: 7, overflowed: 9_000_000, failures: 12, closed: false,
    filePath: '/home/PRIVATE/transcript.jsonl', token: 'PRIVATE_TOKEN', error: 'PRIVATE_ERROR',
    scan: () => assert.fail('owner refresh must not start a scan'),
  };
  const subject = await fixture({ indexing: () => source });
  context.after(subject.close);
  for (let request = 0; request < 3; request += 1) {
    const response = await fetch(`${subject.url}?refresh=true&scan=true`, { headers: { 'x-test-auth': 'owner' } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = await response.text();
    assert.doesNotMatch(body, /PRIVATE|filePath|token|error|transcript\.jsonl/);
    assert.deepEqual(JSON.parse(body).indexing, {
      status: 'accepting', pending: 64, active: 4, maxPending: 448, maxActive: 4,
      reconciling: 2, reconciliationPending: 7, overflowed: 1_000_000, failures: 12,
    });
  }
  assert.equal(subject.indexingReads(), 1);
});

test('indexing getter failures stay private and do not make the owner API fail', async (context) => {
  const subject = await fixture({ indexing: () => { throw new Error('PRIVATE_ERROR /home/private/token'); } });
  context.after(subject.close);
  const response = await fetch(subject.url, { headers: { 'x-test-auth': 'owner' } });
  assert.equal(response.status, 200);
  const body = await response.text();
  const data = JSON.parse(body);
  assert.equal(data.indexing.status, 'unavailable');
  assert.equal(data.indexing.active, null);
  assert.equal(data.indexing.overflowed, null);
  assert.equal(data.eventLoop.utilization, 0.2);
  assert.doesNotMatch(body, /PRIVATE|\/home\/private|token/);
});
