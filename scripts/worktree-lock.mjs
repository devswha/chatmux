import { randomUUID } from 'node:crypto';
import { watch } from 'node:fs';
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { processGroupAlive, processIdentityAlive, readProcessIdentity } from './worktree-lock-identity.mjs';

export class WorktreeLockError extends Error {
  constructor(message) { super(message); this.name = 'WorktreeLockError'; }
}

function errorCode(error) {
  return error instanceof Error && 'code' in error ? error.code : undefined;
}

function armPathChange(parent, name, deadlineAt) {
  let cancel;
  const changed = new Promise((resolve, reject) => {
    const watcher = watch(parent, (_event, filename) => {
      if (filename !== null && filename?.toString() !== name) return;
      clearTimeout(timeout); watcher.close(); resolve();
    });
    const remainingMs = deadlineAt - Date.now();
    const timeout = setTimeout(() => { watcher.close(); reject(new WorktreeLockError(`Timed out waiting for ${path.join(parent, name)}.`)); }, Math.max(remainingMs, 0));
    watcher.once('error', (error) => { clearTimeout(timeout); watcher.close(); reject(error); });
    cancel = () => { clearTimeout(timeout); watcher.close(); resolve(); };
  });
  return { changed, cancel: () => cancel?.() };
}

function validIdentity(value) {
  return value !== null && typeof value === 'object' && Number.isSafeInteger(value.pid)
    && value.pid > 0 && typeof value.startTime === 'string' && value.startTime.length > 0;
}

function parseMetadata(raw) {
  let value;
  try { value = JSON.parse(raw); } catch { throw new WorktreeLockError('Worktree lock metadata is malformed.'); }
  const childValid = value?.child === null || (validIdentity(value?.child)
    && (value.child.processGroupId === null || (Number.isSafeInteger(value.child.processGroupId) && value.child.processGroupId > 0)));
  if (value?.version !== 2 || typeof value.token !== 'string' || value.token.length === 0
    || typeof value.lock?.dev !== 'string' || typeof value.lock?.ino !== 'string'
    || !validIdentity(value.wrapper) || !childValid) throw new WorktreeLockError('Worktree lock metadata is malformed.');
  return value;
}

async function safeParent(lockPath) {
  if (!path.isAbsolute(lockPath) || path.basename(lockPath) === lockPath) throw new WorktreeLockError('Worktree lock path must be absolute.');
  const parent = path.dirname(lockPath);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const [canonical, stats] = await Promise.all([realpath(parent), lstat(parent)]);
  if (canonical !== parent || !stats.isDirectory() || stats.isSymbolicLink()) throw new WorktreeLockError('Worktree lock parent must be a canonical directory.');
  return parent;
}

async function snapshot(target) {
  let stats;
  try { stats = await lstat(target, { bigint: true }); } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new WorktreeLockError('Worktree lock must be a real directory.');
  let raw;
  try { raw = await readFile(path.join(target, 'owner.json'), 'utf8'); } catch (error) {
    if (errorCode(error) === 'ENOENT') throw new WorktreeLockError('Worktree lock metadata is missing.');
    throw error;
  }
  const metadata = parseMetadata(raw);
  const identity = { dev: stats.dev.toString(), ino: stats.ino.toString() };
  if (metadata.lock.dev !== identity.dev || metadata.lock.ino !== identity.ino) throw new WorktreeLockError('Worktree lock inode identity is invalid.');
  return { identity, metadata };
}

function sameSnapshot(left, right) {
  return left.identity.dev === right.identity.dev && left.identity.ino === right.identity.ino
    && JSON.stringify(left.metadata) === JSON.stringify(right.metadata);
}

async function ownerActive(owner) {
  if (await processIdentityAlive(owner.wrapper)) return true;
  if (owner.child === null) return false;
  return await processIdentityAlive(owner.child) || processGroupAlive(owner.child.processGroupId);
}

async function acquireMutationGate(parent, lockName, deadlineAt) {
  const gate = path.join(parent, `.${lockName}.mutation`);
  const gateName = path.basename(gate);
  const attempt = async () => {
    if (Date.now() >= deadlineAt) throw new WorktreeLockError(`Timed out waiting for ${gate}.`);
    const change = armPathChange(parent, gateName, deadlineAt);
    const token = randomUUID(); const candidate = `${gate}.candidate-${token}`;
    try {
      await mkdir(candidate, { mode: 0o700 });
      await writeFile(path.join(candidate, 'owner.json'), `${JSON.stringify(await readProcessIdentity(process.pid))}\n`, { mode: 0o600 });
      try {
        await rename(candidate, gate); change.cancel();
        return async () => {
          const released = `${gate}.released-${token}`;
          await rename(gate, released); await rm(released, { recursive: true, force: true });
        };
      } catch (error) {
        if (errorCode(error) !== 'EEXIST' && errorCode(error) !== 'ENOTEMPTY') throw error;
      }
    } finally { await rm(candidate, { recursive: true, force: true }); }
    let holder;
    try { holder = JSON.parse(await readFile(path.join(gate, 'owner.json'), 'utf8')); } catch (error) {
      if (errorCode(error) === 'ENOENT') { await change.changed; return attempt(); }
      change.cancel(); throw new WorktreeLockError('Worktree lock mutation gate is malformed.');
    }
    if (!validIdentity(holder) || !(await processIdentityAlive(holder))) {
      change.cancel(); throw new WorktreeLockError('Worktree lock mutation gate has no live owner.');
    }
    await change.changed; return attempt();
  };
  return attempt();
}

async function withMutation(lockPath, deadlineAt, operation) {
  const parent = path.dirname(lockPath); const release = await acquireMutationGate(parent, path.basename(lockPath), deadlineAt);
  try { return await operation(); } finally { await release(); }
}

async function createLock(lockPath, wrapper) {
  const candidate = `${lockPath}.candidate-${randomUUID()}`;
  await mkdir(candidate, { mode: 0o700 });
  try {
    const stats = await lstat(candidate, { bigint: true });
    const metadata = {
      version: 2, token: randomUUID(), lock: { dev: stats.dev.toString(), ino: stats.ino.toString() },
      wrapper, child: null,
    };
    await writeFile(path.join(candidate, 'owner.json'), `${JSON.stringify(metadata)}\n`, { mode: 0o600 });
    await rename(candidate, lockPath);
    return { identity: metadata.lock, metadata };
  } finally { await rm(candidate, { recursive: true, force: true }); }
}

async function restoreMoved(lockPath, moved, expected) {
  const observed = await snapshot(moved);
  if (observed !== undefined && sameSnapshot(observed, expected)) return observed;
  try { await rename(moved, lockPath); } catch (error) {
    if (errorCode(error) === 'EEXIST' || errorCode(error) === 'ENOTEMPTY') throw new WorktreeLockError(`Mismatched moved lock was deferred at ${moved}.`);
    throw error;
  }
  throw new WorktreeLockError('Stale lock changed identity during quarantine.');
}

export async function recordOwnedChild(lockPath, expected, child, deadlineAt = Date.now() + 60_000) {
  await withMutation(lockPath, deadlineAt, async () => {
    const current = await snapshot(lockPath);
    if (current === undefined || current.metadata.token !== expected.token
      || current.identity.dev !== expected.lock.dev || current.identity.ino !== expected.lock.ino) throw new WorktreeLockError('Worktree lock ownership changed before child registration.');
    if (current.metadata.child !== null) throw new WorktreeLockError('Worktree lock child identity is immutable.');
    const metadata = { ...current.metadata, child };
    const temporary = path.join(lockPath, `.owner-${randomUUID()}.json`);
    await writeFile(temporary, `${JSON.stringify(metadata)}\n`, { mode: 0o600 });
    await rename(temporary, path.join(lockPath, 'owner.json'));
  });
}

export async function releaseOwnedLock(lockPath, expected, deadlineAt = Date.now() + 60_000) {
  await withMutation(lockPath, deadlineAt, async () => {
    const current = await snapshot(lockPath);
    if (current === undefined || current.metadata.token !== expected.token
      || current.identity.dev !== expected.lock.dev || current.identity.ino !== expected.lock.ino) return;
    const moved = `${lockPath}.released-${expected.token}`;
    await rename(lockPath, moved); await restoreMoved(lockPath, moved, current); await rm(moved, { recursive: true, force: true });
  });
}

export async function acquireWorktreeLock(lockPath, options = {}) {
  const parent = await safeParent(lockPath); const lockName = path.basename(lockPath);
  const deadlineAt = Date.now() + (options.timeoutMs ?? 15 * 60_000);
  const wrapper = await readProcessIdentity(process.pid);
  if (wrapper === null) throw new WorktreeLockError('Cannot identify the verify wrapper process.');
  let waitReported = false;
  const attempt = async () => {
    if (Date.now() >= deadlineAt) throw new WorktreeLockError(`Timed out waiting for ${lockPath}.`);
    const change = armPathChange(parent, lockName, deadlineAt);
    let current;
    try { current = await snapshot(lockPath); } catch (error) { change.cancel(); throw error; }
    if (current === undefined) {
      current = await withMutation(lockPath, deadlineAt, async () => (await snapshot(lockPath)) ?? createLock(lockPath, wrapper));
      if (current.metadata.wrapper.pid === process.pid) {
        change.cancel(); const expected = { token: current.metadata.token, lock: current.identity };
        return {
          ...expected,
          recordChild: (child) => recordOwnedChild(lockPath, expected, child, deadlineAt),
          release: () => releaseOwnedLock(lockPath, expected, deadlineAt),
        };
      }
    }
    if (await ownerActive(current.metadata)) {
      if (!waitReported) { waitReported = true; options.onWait?.(current.metadata); }
      await change.changed; return attempt();
    }
    await options.onStaleObserved?.(current.metadata);
    await withMutation(lockPath, deadlineAt, async () => {
      const observed = await snapshot(lockPath);
      if (observed === undefined || !sameSnapshot(observed, current)) return;
      const moved = `${lockPath}.stale-${randomUUID()}`;
      await rename(lockPath, moved); await restoreMoved(lockPath, moved, current);
      options.onStale?.(current.metadata); await rm(moved, { recursive: true, force: true });
    });
    change.cancel(); return attempt();
  };
  return attempt();
}
