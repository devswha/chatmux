import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  REMOTE_HEALTH_MAX_RESPONSE_BYTES,
  REMOTE_SERVER_PROBE_TIMEOUT_MS,
  RemoteServersStore,
  normalizeRemoteServerUrl,
  probeRemoteServer,
} from './remoteServers.js';

function jsonResponse(body, status = 200) {
  return new Response(
    typeof body === 'string' ? body : JSON.stringify(body),
    { status, headers: { 'content-type': 'application/json' } },
  );
}

async function createStore(options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmux-remote-servers-'));
  const storePath = path.join(directory, 'remote-servers.json');
  return {
    directory,
    storePath,
    store: new RemoteServersStore({ storePath, ...options }),
  };
}

async function removeStore({ directory }) {
  await fs.rm(directory, { recursive: true, force: true });
}

test('requires HTTPS for remote servers and permits HTTP only for exact loopback origins', () => {
  assert.equal(normalizeRemoteServerUrl(' HTTPS://Example.COM:443/ '), 'https://example.com');
  assert.equal(normalizeRemoteServerUrl('http://localhost:3000/'), 'http://localhost:3000');
  assert.equal(normalizeRemoteServerUrl('http://127.0.0.1:3000/'), 'http://127.0.0.1:3000');
  assert.equal(normalizeRemoteServerUrl('http://[::1]:3000/'), 'http://[::1]:3000');
  assert.throws(() => normalizeRemoteServerUrl('http://example.com:80/'), /HTTPS origin/);
  assert.throws(() => normalizeRemoteServerUrl('http://127.0.0.2:3000/'), /HTTPS origin/);
  assert.throws(() => normalizeRemoteServerUrl('https://user:pass@example.com/'));
  assert.throws(() => normalizeRemoteServerUrl('https://example.com/?token=value'));
  assert.throws(() => normalizeRemoteServerUrl('https://example.com/#fragment'));
  assert.throws(() => normalizeRemoteServerUrl('https://example.com/path'));
  assert.throws(() => normalizeRemoteServerUrl('file:///tmp/server'));
});

test('validates CRUD input, preserves opaque IDs, and prevents exact-origin duplicates', async () => {
  const fixture = await createStore({
    randomUUID: (() => {
      let sequence = 0;
      return () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`;
    })(),
  });

  try {
    await assert.rejects(fixture.store.create({ name: ' ', url: 'https://one.example/' }));
    await assert.rejects(fixture.store.create({ name: 'One', url: 'https://one.example/?x=1' }));

    const first = await fixture.store.create({ name: '  First target  ', url: 'https://ONE.example:443/' });
    assert.deepEqual(first, { id: '00000000-0000-4000-8000-000000000001', name: 'First target', url: 'https://one.example' });
    await assert.rejects(fixture.store.create({ name: 'Duplicate', url: 'https://one.example/' }), /exact origin/);
    await assert.rejects(fixture.store.update(first.id, { id: 'replacement' }), /not allowed/);
    await assert.rejects(fixture.store.update('bad', { name: 'Changed' }), /ID is invalid/);

    const updated = await fixture.store.update(first.id, { name: ' Changed target ' });
    assert.deepEqual(updated, { id: first.id, name: 'Changed target', url: first.url });
    await fixture.store.select(first.id);

    const reloaded = new RemoteServersStore({ storePath: fixture.storePath });
    assert.deepEqual(await reloaded.getState(), {
      version: 1,
      selectedId: first.id,
      servers: [{ id: first.id, name: 'Changed target', url: 'https://one.example' }],
    });

    await fixture.store.delete(first.id);
    assert.deepEqual(await fixture.store.getState(), { version: 1, selectedId: null, servers: [] });
    await assert.rejects(fixture.store.delete(first.id), /not found/);
  } finally {
    await removeStore(fixture);
  }
});

test('atomically persists state and fails closed on malformed persisted data', async () => {
  const writes = [];
  const renames = [];
  const fsImpl = {
    mkdir: fs.mkdir.bind(fs),
    readFile: fs.readFile.bind(fs),
    writeFile: async (filePath, ...args) => {
      writes.push(filePath);
      return fs.writeFile(filePath, ...args);
    },
    rename: async (from, to) => {
      renames.push([from, to]);
      return fs.rename(from, to);
    },
    rm: fs.rm.bind(fs),
  };
  const fixture = await createStore({ fsImpl });

  try {
    await fixture.store.create({ name: 'Atomic', url: 'https://atomic.example/' });
    assert.equal(writes.length, 1);
    assert.notEqual(writes[0], fixture.storePath);
    assert.equal(renames.length, 1);
    assert.equal(renames[0][1], fixture.storePath);
    assert.match(await fs.readFile(fixture.storePath, 'utf8'), /"version": 1/);

    await fs.writeFile(fixture.storePath, '{not-json', 'utf8');
    const malformed = new RemoteServersStore({ storePath: fixture.storePath });
    await assert.rejects(malformed.getState(), /store is invalid/);
    await assert.rejects(
      malformed.create({ name: 'Blocked', url: 'https://blocked.example' }),
      /store is invalid/,
    );
    assert.match(await fs.readFile(fixture.storePath, 'utf8'), /\{not-json/);
  } finally {
    await removeStore(fixture);
  }
});

test('health probes are explicit, credentialless, redirect-safe, and fail closed', async () => {
  let requestedUrl = null;
  let requestedOptions = null;
  const health = await probeRemoteServer('https://probe.example/', {
    fetchImpl: async (url, options) => {
      requestedUrl = url;
      requestedOptions = options;
      return jsonResponse({
        status: 'ok',
        product: 'chatmux',
        protocolVersion: 1,
        version: '1.2.3',
      });
    },
  });

  assert.deepEqual(health, { status: 'ok', product: 'chatmux', protocolVersion: 1, version: '1.2.3' });
  assert.equal(requestedUrl, 'https://probe.example/health');
  assert.equal(requestedOptions.method, 'GET');
  assert.equal(requestedOptions.credentials, 'omit');
  assert.equal(requestedOptions.redirect, 'manual');
  assert.equal(requestedOptions.cache, 'no-store');
  assert.equal(requestedOptions.headers, undefined);

  await assert.rejects(probeRemoteServer('https://probe.example/', {
    fetchImpl: async () => jsonResponse({}, 302),
  }), /redirect/);
  await assert.rejects(probeRemoteServer('https://probe.example/', {
    fetchImpl: async () => jsonResponse({}, 503),
  }), /HTTP 503/);
  await assert.rejects(probeRemoteServer('https://probe.example/', {
    fetchImpl: async () => jsonResponse('{bad JSON'),
  }), /malformed JSON/);
  await assert.rejects(probeRemoteServer('https://probe.example/', {
    fetchImpl: async () => jsonResponse({ status: 'ok', product: 'chatmux', protocolVersion: 1 }),
  }), /unexpected server identity/);
  await assert.rejects(probeRemoteServer('https://probe.example/', {
    fetchImpl: async () => jsonResponse({ status: 'ok', product: 'chatmux', protocolVersion: '1', version: '1.2.3' }),
  }), /unexpected server identity/);
  await assert.rejects(probeRemoteServer('https://probe.example/', {
    fetchImpl: async () => jsonResponse({ status: 'ok', product: 'chatmux', protocolVersion: 1, version: ' ' }),
  }), /unexpected server identity/);
  await assert.rejects(probeRemoteServer('https://probe.example/', {
    fetchImpl: async () => jsonResponse('x'.repeat(REMOTE_HEALTH_MAX_RESPONSE_BYTES + 1)),
  }), /size limit/);
  let declaredOversizeCancelled = false;
  const declaredOversize = new Response(new ReadableStream({
    cancel() {
      declaredOversizeCancelled = true;
    },
  }), {
    headers: { 'content-length': String(REMOTE_HEALTH_MAX_RESPONSE_BYTES + 1) },
  });
  await assert.rejects(probeRemoteServer('https://probe.example/', {
    fetchImpl: async () => declaredOversize,
  }), /size limit/);
  assert.equal(declaredOversizeCancelled, true);
  await assert.rejects(probeRemoteServer('https://probe.example/', {
    fetchImpl: async () => { throw new TypeError('network offline'); },
  }), /failed/);

  await assert.rejects(probeRemoteServer('https://probe.example/', {
    timeoutMs: 1,
    fetchImpl: () => new Promise(() => {}),
  }), /timed out/);
  assert.equal(REMOTE_SERVER_PROBE_TIMEOUT_MS, 3_000);
});
