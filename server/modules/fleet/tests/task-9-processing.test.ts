import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import type { DiscoverySnapshot } from '@/modules/providers/index.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';

import { parseFleetCatalogDelta } from '../catalog/schema.js';
import { PeerCatalogPublisher } from '../peer/catalog-publisher.js';
import { createPeerCatalogSource } from '../peer/catalog-source.js';

const HOST = '10000000-0000-4000-8000-000000000001';
const discovery: DiscoverySnapshot = { epoch: 'discovery', revision: 0, takenAtMs: 1, rows: [], health: { external: { ok: true, lastOkRevision: null, consecutiveFailures: 0 }, live: { ok: true, lastOkRevision: null, consecutiveFailures: 0 } } };
class Connection { readonly readyState = 1; send(): void {} }
function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  const timeout = Promise.withResolvers<T>(); const timer = setTimeout(() => timeout.reject(new TypeError(`${label} timeout`)), 2_000);
  return Promise.race([promise, timeout.promise]).finally(() => clearTimeout(timer));
}

test('Given no discovery events, when a real run starts, sequences, and completes, then ordered processing deltas publish', async () => {
  const previousPath = process.env.DATABASE_PATH; const root = await mkdtemp(path.join(tmpdir(), 'fleet-processing-'));
  closeConnection(); process.env.DATABASE_PATH = path.join(root, 'catalog.db'); await initializeDatabase();
  const discoveryListeners = new Set<(snapshot: DiscoverySnapshot) => void>();
  const source = createPeerCatalogSource({ hostId: HOST, displayLabel: 'peer', capabilities: ['catalog.read'], discovery: { start() {}, stop() {}, dispose() {}, setActive() {}, forceRefresh() {}, tick: async () => undefined, ensureFresh: async () => undefined, currentSnapshot: () => discovery, currentDetailed: () => ({ takenAtMs: null, external: null, live: null }), onSnapshot: (listener) => { discoveryListeners.add(listener); return () => discoveryListeners.delete(listener); } } });
  const publisher = new PeerCatalogPublisher({ epoch: 'peer', read: source.read, subscribe: source.subscribe });
  let signal = Promise.withResolvers<ReturnType<typeof parseFleetCatalogDelta>>(); const deltas: ReturnType<typeof parseFleetCatalogDelta>[] = [];
  const release = await publisher.accept((event, body) => { if (event === 'catalog.delta') { const parsed = parseFleetCatalogDelta(body); deltas.push(parsed); signal.resolve(parsed); } });
  sessionsDb.createAppSession('processing', 'codex', '/workspace/project');
  try {
    const startSignal = signal.promise; const run = chatRunRegistry.startRun({ appSessionId: 'processing', provider: 'codex', providerSessionId: null, connection: new Connection(), userId: null }); assert.ok(run);
    assert.equal((await bounded(startSignal, 'start')).changes[0]?.op, 'upsert');
    signal = Promise.withResolvers(); const sequenceSignal = signal.promise; run.writer.send({ kind: 'text', provider: 'codex', sessionId: 'native', content: 'one' });
    assert.equal((await bounded(sequenceSignal, 'sequence')).changes[0]?.entity, 'processing');
    signal = Promise.withResolvers(); const completionSignal = signal.promise; run.writer.send({ kind: 'complete', provider: 'codex', sessionId: 'native', exitCode: 0 });
    assert.equal((await bounded(completionSignal, 'completion')).changes[0]?.op, 'remove');
    assert.deepEqual(deltas.map((item) => item.revision), [2, 3, 4]);
    publisher.stop(); assert.equal(discoveryListeners.size, 0);
    const count = deltas.length; chatRunRegistry.startRun({ appSessionId: 'after-stop', provider: 'codex', providerSessionId: null, connection: new Connection(), userId: null }); await publisher.whenIdle(); assert.equal(deltas.length, count);
  } finally {
    release(); publisher.stop(); chatRunRegistry.clearAll(); closeConnection(); if (previousPath === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previousPath; await rm(root, { recursive: true, force: true });
  }
});
