import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { ImmutableUpdateJobDescriptor } from './release-update-contract.js';
import { ReleaseUpdateStateError, ReleaseUpdateStateStore, UPDATE_STATE_RETENTION_MS, UPDATE_STATE_TERMINAL_CAP, type StateFileSystem } from './release-update-state.js';

function root(): string { return mkdtempSync(path.join(tmpdir(), 'chatmux-update-state-')); }
function id(index: number): string { return index.toString(36).padStart(22, '0'); }
function descriptor(index: number, createdAt = 1): ImmutableUpdateJobDescriptor {
  const version = `1.0.${index}`;
  const archiveName = `chatmux-server-${version}-linux-x64-node22.tar.gz`;
  return {
    id: id(index), createdAt, installMode: 'release', sourceVersion: '1.0.0', sourceBootId: 'boot-test', serverPort: 3000,
    release: { repository: 'devswha/chatmux', tag: `v${version}`, version, archiveName, checksumName: `${archiveName}.sha256`, bootstrapName: 'install.sh', archiveSha256: 'a'.repeat(64), publishedAt: '2026-01-01T00:00:00.000Z' },
    compatibility: { database: { rollbackCompatibleFrom: [] } },
  };
}

test('createIfNoActive serializes durable active release jobs', () => {
  const directory = root();
  const store = new ReleaseUpdateStateStore(directory);
  const first = descriptor(1);
  assert.ok(store.createIfNoActive(first));
  assert.equal(store.createIfNoActive(descriptor(2)), null);
  store.transition(first.id, 'succeeded');
  assert.ok(store.createIfNoActive(descriptor(2)));
});
function cleanup(directory: string): void { rmSync(directory, { recursive: true, force: true }); }

test('terminal jobs survive a fresh store and public status is redacted', () => {
  const directory = root();
  try {
    const clock = 100;
    const first = new ReleaseUpdateStateStore(directory, { now: () => clock });
    first.create(descriptor(1));
    first.transition(id(1), 'succeeded', 'failed at /home/user/.chatmux https://internal.invalid token=secret');
    const second = new ReleaseUpdateStateStore(directory, { now: () => clock });
    const status = second.publicStatus(id(1));
    assert.equal(status?.phase, 'succeeded');
    assert.equal('completionOrdinal' in (status ?? {}), false);
    assert.equal(status?.error, 'failed at [redacted] [redacted] [redacted]');
    assert.equal(JSON.stringify(status).includes('/home/user'), false);
  } finally { cleanup(directory); }
});
test('active jobs survive a router restart with only sanitized status exposed', () => {
  const directory = root();
  try {
    const first = new ReleaseUpdateStateStore(directory);
    const job = descriptor(1);
    first.createIfNoActive(job);
    const resumed = new ReleaseUpdateStateStore(directory).publicActiveStatus();
    assert.deepEqual(resumed, {
      id: job.id, phase: 'queued', createdAt: job.createdAt, updatedAt: resumed?.updatedAt, targetVersion: job.release.version,
    });
    assert.equal(JSON.stringify(resumed).includes('sourceBootId'), false);
    assert.equal(JSON.stringify(resumed).includes('serverPort'), false);
  } finally { cleanup(directory); }
});
test('proven inactive active job becomes a durable sanitized failure and frees single-flight', () => {
  const directory = root();
  try {
    const store = new ReleaseUpdateStateStore(directory, { now: () => 100 });
    const job = descriptor(1);
    store.createIfNoActive(job);
    assert.equal(store.failIfInactive(job.id, () => false)?.phase, 'failed');
    const status = new ReleaseUpdateStateStore(directory, { now: () => 100 }).publicStatus(job.id);
    assert.deepEqual(status && { phase: status.phase, error: status.error, completedAt: status.completedAt }, {
      phase: 'failed', error: 'Updater stopped before completion', completedAt: 100,
    });
    assert.ok(store.createIfNoActive(descriptor(2)));
  } finally { cleanup(directory); }
});

test('download progress lives in a sidecar, never the v1 state file, and dies with the job', () => {
  const directory = root();
  try {
    const store = new ReleaseUpdateStateStore(directory, { now: () => 100 });
    const job = descriptor(1);
    store.create(job);
    store.transition(job.id, 'downloading');
    store.recordDownloadProgress(job.id, { downloadedBytes: 1024 });
    assert.deepEqual(store.publicStatus(job.id)?.progress, { downloadedBytes: 1024 });
    store.recordDownloadProgress(job.id, { downloadedBytes: 2048, totalBytes: 4096 });
    // Rollback compatibility: a prior release's closed-schema reader must be
    // able to parse the state file, so progress may never appear in it.
    assert.equal(readFileSync(path.join(directory, 'release-update-state.json'), 'utf8').includes('progress'), false);
    const resumed = new ReleaseUpdateStateStore(directory, { now: () => 100 });
    assert.deepEqual(resumed.publicActiveStatus()?.progress, { downloadedBytes: 2048, totalBytes: 4096 });
    assert.throws(() => store.recordDownloadProgress(job.id, { downloadedBytes: 5000, totalBytes: 4096 }), ReleaseUpdateStateError);
    assert.throws(() => store.recordDownloadProgress(job.id, { downloadedBytes: -1 }), ReleaseUpdateStateError);
    store.transition(job.id, 'succeeded');
    assert.throws(() => store.recordDownloadProgress(job.id, { downloadedBytes: 4096 }), ReleaseUpdateStateError);
    assert.equal(store.publicStatus(job.id)?.progress, undefined);
    assert.equal(fs.existsSync(path.join(directory, 'release-update-progress.json')), false);
  } finally { cleanup(directory); }
});

test('inactive recovery never mutates invalid or corrupt records', () => {
  const directory = root();
  try {
    writeFileSync(path.join(directory, 'release-update-state.json'), '{not json');
    const store = new ReleaseUpdateStateStore(directory);
    assert.throws(() => store.failIfInactive(id(1), () => false), ReleaseUpdateStateError);
    assert.equal(readFileSync(path.join(directory, 'release-update-state.json'), 'utf8'), '{not json');
    assert.equal(store.failIfInactive('untrusted', () => false), null);
  } finally { cleanup(directory); }
});
test('state lock records an owner PID and only recovers a proven-dead owner', () => {
  const directory = root();
  try {
    const store = new ReleaseUpdateStateStore(directory, { isProcessAlive: () => false });
    store.initialize();
    writeFileSync(path.join(directory, 'release-update-state.lock'), '999999\n');
    assert.equal(store.get(id(1)), null);
    writeFileSync(path.join(directory, 'release-update-state.lock'), '');
    assert.throws(() => store.get(id(1)), ReleaseUpdateStateError);
  } finally { cleanup(directory); }
});

test('completion ordinal, not timestamps or random IDs, selects the count-prune victim across restart', () => {
  const directory = root();
  try {
    const store = new ReleaseUpdateStateStore(directory, { now: () => 1_000 });
    for (let index = 1; index <= UPDATE_STATE_TERMINAL_CAP + 1; index += 1) {
      store.create(descriptor(index));
      store.transition(id(index), 'succeeded');
    }
    const restarted = new ReleaseUpdateStateStore(directory, { now: () => 1_000 });
    restarted.initialize();
    assert.equal(restarted.get(id(1)), null, 'oldest completion ordinal is pruned despite its lexical ID');
    assert.ok(restarted.get(id(UPDATE_STATE_TERMINAL_CAP + 1)));
  } finally { cleanup(directory); }
});
test('allocator high-water survives a crash gap before a terminal record commit', () => {
  const directory = root();
  try {
    const store = new ReleaseUpdateStateStore(directory, { now: () => 10 });
    store.create(descriptor(1));
    writeFileSync(path.join(directory, 'release-update-completion-ordinal.json'), JSON.stringify({ nextCompletionOrdinal: 9 }));
    store.transition(id(1), 'succeeded');
    assert.equal(store.get(id(1))?.completionOrdinal, 10);
  } finally { cleanup(directory); }
});

test('missing allocator is repaired before age pruning and remains durable on a second restart', () => {
  const directory = root();
  try {
    const old = descriptor(1, 1);
    writeFileSync(path.join(directory, 'release-update-state.json'), JSON.stringify({ schemaVersion: 1, jobs: {
      [old.id]: { descriptor: old, phase: 'succeeded', updatedAt: 1, completedAt: 1, completionOrdinal: 7, locked: false },
    } }));
    const now = UPDATE_STATE_RETENTION_MS + 2;
    new ReleaseUpdateStateStore(directory, { now: () => now }).initialize();
    assert.deepEqual(JSON.parse(readFileSync(path.join(directory, 'release-update-completion-ordinal.json'), 'utf8')), { nextCompletionOrdinal: 7 });
    assert.equal(new ReleaseUpdateStateStore(directory, { now: () => now }).get(old.id), null);
    new ReleaseUpdateStateStore(directory, { now: () => now }).initialize();
  } finally { cleanup(directory); }
});

test('retention boundaries exempt active, locked, and exactly-thirty-day terminal jobs', () => {
  const directory = root();
  try {
    const now = UPDATE_STATE_RETENTION_MS + 100;
    const store = new ReleaseUpdateStateStore(directory, { now: () => now });
    store.create(descriptor(1));
    store.create(descriptor(2)); store.transition(id(2), 'succeeded');
    const statePath = path.join(directory, 'release-update-state.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    state.jobs[id(2)].completedAt = 100; // exactly now - 30 days
    state.jobs[id(2)].locked = true;
    writeFileSync(statePath, JSON.stringify(state));
    store.initialize();
    assert.ok(store.get(id(1)), 'active record is exempt');
    assert.ok(store.get(id(2)), 'locked terminal record is exempt');
  } finally { cleanup(directory); }
});

test('corruption and persistence failure fail closed before allocation or pruning', () => {
  const directory = root();
  try {
    writeFileSync(path.join(directory, 'release-update-state.json'), '{not json');
    const store = new ReleaseUpdateStateStore(directory);
    assert.throws(() => store.initialize(), ReleaseUpdateStateError);
    assert.equal(fs.existsSync(path.join(directory, 'release-update-completion-ordinal.json')), false);
  } finally { cleanup(directory); }

  const failingDirectory = root();
  try {
    const failingFs: StateFileSystem = {
      ...fs,
      writeFileSync() { throw new Error('injected write failure'); },
    };
    const store = new ReleaseUpdateStateStore(failingDirectory, { fs: failingFs });
    assert.throws(() => store.create(descriptor(1)), ReleaseUpdateStateError);
    assert.equal(fs.existsSync(path.join(failingDirectory, 'release-update-state.json')), false);
  } finally { cleanup(failingDirectory); }
});

test('atomic persistence fsyncs temporary file before rename and fsyncs parent after rename', () => {
  const directory = root();
  const events: string[] = [];
  try {
    const recordingFs: StateFileSystem = {
      ...fs,
      fsyncSync(fd) { events.push('fsync'); fs.fsyncSync(fd); },
      renameSync(oldPath, newPath) { events.push(`rename:${path.basename(newPath)}`); fs.renameSync(oldPath, newPath); },
    };
    new ReleaseUpdateStateStore(directory, { fs: recordingFs }).create(descriptor(1));
    const rename = events.findIndex((event) => event.startsWith('rename:release-update-state.json'));
    assert.ok(rename > 0);
    assert.equal(events[rename - 1], 'fsync');
    assert.equal(events[rename + 1], 'fsync');
  } finally { cleanup(directory); }
});
test('initialization atomically completes a terminal locked commit after restart', () => {
  const directory = root();
  try {
    const store = new ReleaseUpdateStateStore(directory, { now: () => 100 });
    store.create(descriptor(1));
    store.transition(id(1), 'succeeded');
    const statePath = path.join(directory, 'release-update-state.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    state.jobs[id(1)].locked = true;
    writeFileSync(statePath, JSON.stringify(state));
    new ReleaseUpdateStateStore(directory, { now: () => 101 }).initialize();
    const recovered = new ReleaseUpdateStateStore(directory, { now: () => 101 }).get(id(1));
    assert.deepEqual(recovered && { locked: recovered.locked, updatedAt: recovered.updatedAt }, { locked: false, updatedAt: 101 });
  } finally { cleanup(directory); }
});

test('recovery checkpoints are validated, durable, and never exposed in public status', () => {
  const directory = root();
  try {
    const store = new ReleaseUpdateStateStore(directory);
    const job = descriptor(1);
    store.create(job);
    const recovery = {
      priorRelease: { path: '/srv/chatmux/releases/1.0.0', version: '1.0.0' },
      targetRelease: { path: '/srv/chatmux/releases/1.0.1', version: '1.0.1' },
      cutoverState: 'prepared' as const, rollbackState: 'not_started' as const,
    };
    store.persistRecoveryCheckpoint(job.id, recovery);
    recovery.priorRelease.path = '/changed';
    assert.deepEqual(store.recoveryCheckpoint(job.id), {
      priorRelease: { path: '/srv/chatmux/releases/1.0.0', version: '1.0.0' },
      targetRelease: { path: '/srv/chatmux/releases/1.0.1', version: '1.0.1' },
      cutoverState: 'prepared', rollbackState: 'not_started',
    });
    assert.equal(JSON.stringify(store.publicStatus(job.id)).includes('priorRelease'), false);
    assert.throws(() => store.persistRecoveryCheckpoint(job.id, {
      ...recovery, priorRelease: { path: 'relative', version: '1.0.0' },
    }), ReleaseUpdateStateError);
    const statePath = path.join(directory, 'release-update-state.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    state.jobs[job.id].recovery.rollbackState = 'unsafe';
    writeFileSync(statePath, JSON.stringify(state));
    assert.throws(() => new ReleaseUpdateStateStore(directory).get(job.id), ReleaseUpdateStateError);
  } finally { cleanup(directory); }
});

test('dead-worker recovery fails closed after cutover and retains durable manual recovery records', () => {
  const directory = root();
  try {
    const now = UPDATE_STATE_RETENTION_MS + 100;
    const store = new ReleaseUpdateStateStore(directory, { now: () => now });
    const pre = descriptor(1); store.create(pre); store.transition(pre.id, 'staging');
    assert.equal(store.failIfInactive(pre.id, () => false)?.phase, 'failed');
    const post = descriptor(2); store.create(post); store.transition(post.id, 'cutting_over');
    assert.throws(() => store.failIfInactive(post.id, () => false), ReleaseUpdateStateError);
    store.persistRecoveryCheckpoint(post.id, {
      priorRelease: { path: '/srv/chatmux/releases/1.0.0', version: '1.0.0' },
      targetRelease: { path: '/srv/chatmux/releases/1.0.2', version: '1.0.2' },
      cutoverState: 'prepared', rollbackState: 'not_started',
    });
    assert.equal(store.failIfInactive(post.id, () => false)?.phase, 'manual_required');
    const statePath = path.join(directory, 'release-update-state.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    state.jobs[post.id].completedAt = 0;
    writeFileSync(statePath, JSON.stringify(state));
    new ReleaseUpdateStateStore(directory, { now: () => now }).initialize();
    assert.equal(new ReleaseUpdateStateStore(directory, { now: () => now }).get(post.id)?.phase, 'manual_required');
  } finally { cleanup(directory); }
});

test('manual_required and failed_rollback records are exempt from count pruning across restart', () => {
  const directory = root();
  try {
    const store = new ReleaseUpdateStateStore(directory, { now: () => 1_000 });
    for (let index = 1; index <= UPDATE_STATE_TERMINAL_CAP + 2; index += 1) {
      store.create(descriptor(index));
      store.transition(id(index), index % 2 ? 'manual_required' : 'failed_rollback');
    }
    const statePath = path.join(directory, 'release-update-state.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    for (const job of Object.values(state.jobs) as Array<{ completedAt: number }>) job.completedAt = 0;
    writeFileSync(statePath, JSON.stringify(state));
    new ReleaseUpdateStateStore(directory, { now: () => UPDATE_STATE_RETENTION_MS + 100 }).initialize();
    for (let index = 1; index <= UPDATE_STATE_TERMINAL_CAP + 2; index += 1) assert.ok(store.get(id(index)));
  } finally { cleanup(directory); }
});
