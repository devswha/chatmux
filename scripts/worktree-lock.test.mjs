import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { acquireWorktreeLock, WorktreeLockError } from './worktree-lock.mjs';

async function writeOwner(lockPath, owner) {
  const stats = await lstat(lockPath, { bigint: true });
  await writeFile(path.join(lockPath, 'owner.json'), `${JSON.stringify({
    version: 2, token: owner.token,
    lock: { dev: stats.dev.toString(), ino: stats.ino.toString() },
    wrapper: owner.wrapper, child: owner.child ?? null,
  })}\n`);
}

const DEAD_WRAPPER = { pid: 2_147_483_647, startTime: 'dead' };

test('worktree lock hands ownership to an event-waiting contender without overlap', async () => {
  // Given
  const root = await mkdtemp(path.join(tmpdir(), 'chatmux-worktree-lock-'));
  const lockPath = path.join(root, 'verify.lock');
  try {
    const first = await acquireWorktreeLock(lockPath, { timeoutMs: 2_000 });
    let announceWaiting; const waiting = new Promise((resolve) => { announceWaiting = resolve; });
    let secondAcquired = false;
    const second = acquireWorktreeLock(lockPath, { timeoutMs: 2_000, onWait: () => announceWaiting?.() })
      .then((ownership) => { secondAcquired = true; return ownership; });
    await waiting; assert.equal(secondAcquired, false);

    // When
    await first.release(); const next = await second;

    // Then
    assert.equal(secondAcquired, true); await next.release();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('worktree lock removes a stale identity before acquiring', async () => {
  // Given
  const root = await mkdtemp(path.join(tmpdir(), 'chatmux-worktree-lock-stale-'));
  const lockPath = path.join(root, 'verify.lock'); await mkdir(lockPath); await writeOwner(lockPath, { token: 'stale-owner', wrapper: DEAD_WRAPPER });
  try {
    let staleOwner;

    // When
    const ownership = await acquireWorktreeLock(lockPath, { timeoutMs: 2_000, onStale: (owner) => { staleOwner = owner; } });

    // Then
    assert.deepEqual(staleOwner.wrapper, DEAD_WRAPPER); assert.notEqual(ownership.token, 'stale-owner'); await ownership.release();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('two simultaneous stale contenders quarantine only the observed inode and serialize', async () => {
  // Given
  const root = await mkdtemp(path.join(tmpdir(), 'chatmux-worktree-lock-race-'));
  const lockPath = path.join(root, 'verify.lock'); await mkdir(lockPath); await writeOwner(lockPath, { token: 'stale-race', wrapper: DEAD_WRAPPER });
  let observations = 0; let releaseObservations; let announceObserved;
  const bothObserved = new Promise((resolve) => { announceObserved = resolve; });
  const observationBarrier = new Promise((resolve) => { releaseObservations = resolve; });
  const options = {
    timeoutMs: 2_000,
    onStaleObserved: async () => { observations += 1; if (observations === 2) announceObserved?.(); await observationBarrier; },
  };
  try {
    const contenders = [acquireWorktreeLock(lockPath, options), acquireWorktreeLock(lockPath, options)];
    await bothObserved; releaseObservations?.();

    // When
    const winner = await Promise.race(contenders.map((promise, index) => promise.then((ownership) => ({ index, ownership }))));
    let loserAcquired = false; const loser = contenders[1 - winner.index].then((ownership) => { loserAcquired = true; return ownership; });
    assert.equal(loserAcquired, false); await winner.ownership.release(); const next = await loser;

    // Then
    assert.equal(loserAcquired, true); await next.release();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('owner PID reuse metadata is stale when process start identity differs', async () => {
  // Given
  const root = await mkdtemp(path.join(tmpdir(), 'chatmux-worktree-lock-reuse-'));
  const lockPath = path.join(root, 'verify.lock'); await mkdir(lockPath);
  await writeOwner(lockPath, { token: 'reused-pid', wrapper: { pid: process.pid, startTime: 'not-this-process' } });
  try {
    // When
    const ownership = await acquireWorktreeLock(lockPath, { timeoutMs: 2_000 });

    // Then
    assert.notEqual(ownership.token, 'reused-pid'); await ownership.release();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('lock rejects symlinked parents, symlink locks, and malformed metadata', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'chatmux-worktree-lock-path-'));
  try {
    const actual = path.join(root, 'actual'); await mkdir(actual); await symlink(actual, path.join(root, 'linked'));
    await assert.rejects(acquireWorktreeLock(path.join(root, 'linked', 'verify.lock'), { timeoutMs: 2_000 }), WorktreeLockError);
    await symlink(actual, path.join(root, 'verify.lock'));
    await assert.rejects(acquireWorktreeLock(path.join(root, 'verify.lock'), { timeoutMs: 2_000 }), WorktreeLockError);
    await rm(path.join(root, 'verify.lock')); await mkdir(path.join(root, 'verify.lock'));
    await writeFile(path.join(root, 'verify.lock', 'owner.json'), '{}\n');

    // When / Then
    await assert.rejects(acquireWorktreeLock(path.join(root, 'verify.lock'), { timeoutMs: 2_000 }), WorktreeLockError);
    assert.equal(await readFile(path.join(root, 'verify.lock', 'owner.json'), 'utf8'), '{}\n');
  } finally { await rm(root, { recursive: true, force: true }); }
});
