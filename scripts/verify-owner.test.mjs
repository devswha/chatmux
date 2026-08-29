import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, watch, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

function armCreated(directory, expected) {
  return new Promise((resolve, reject) => {
    const watcher = watch(directory, (_event, filename) => {
      if (filename !== expected) return;
      clearTimeout(timeout); watcher.close(); resolve();
    });
    const timeout = setTimeout(() => { watcher.close(); reject(new TypeError(`fixture signal timed out: ${expected}`)); }, 10_000);
    watcher.once('error', (error) => { clearTimeout(timeout); watcher.close(); reject(error); });
  });
}

function spawnOwner(lockPath, root, id) {
  const child = spawn(process.execPath, [
    'scripts/verify-owner.mjs', '--lock-path', lockPath, '--',
    process.execPath, 'scripts/verify-owner-fixture.mjs', root, id,
  ], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
  const events = new Map(); const waiters = new Map();
  let output = ''; let stdoutBuffer = '';
  child.stdout.on('data', (chunk) => {
    const text = chunk.toString(); output += text; stdoutBuffer += text;
    let newline = stdoutBuffer.indexOf('\n');
    while (newline >= 0) {
      const line = stdoutBuffer.slice(0, newline); stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (line.startsWith('{')) {
        const event = JSON.parse(line); const name = event.verifyOwnerEvent;
        if (typeof name === 'string') {
          events.set(name, event); waiters.get(name)?.(event); waiters.delete(name);
        }
      }
      newline = stdoutBuffer.indexOf('\n');
    }
  });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal, output }));
  });
  const waitForEvent = (name) => {
    const existing = events.get(name);
    if (existing !== undefined) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { waiters.delete(name); reject(new TypeError(`owner ${id} event timed out: ${name}; ${output}`)); }, 10_000);
      waiters.set(name, (event) => { clearTimeout(timeout); resolve(event); });
    });
  };
  return { child, exited, waitForEvent };
}

function release(root, id) {
  writeFileSync(path.join(root, `release-${id}`), 'release');
}

async function stop(owner, root, id) {
  if (owner === undefined) return;
  const active = existsSync(path.join(root, 'active'));
  const finished = active ? armCreated(root, `finished-${id}`) : Promise.resolve();
  release(root, id);
  if (owner.child.exitCode === null && owner.child.signalCode === null) owner.child.kill('SIGKILL');
  await Promise.all([owner.exited, finished]);
}

test('two verify owners serialize generated and test phases without overlap', async () => {
  // Given
  const root = mkdtempSync(path.join(tmpdir(), 'chatmux-verify-owner-'));
  const lockPath = path.join(root, 'verify.lock');
  let first; let second;
  try {
    const firstStarted = armCreated(root, 'started-first'); first = spawnOwner(lockPath, root, 'first'); await firstStarted;
    second = spawnOwner(lockPath, root, 'second'); await second.waitForEvent('waiting');
    assert.equal(existsSync(path.join(root, 'started-second')), false);

    // When
    const secondStarted = armCreated(root, 'started-second'); release(root, 'first');
    const [firstExit] = await Promise.all([first.exited, secondStarted]); release(root, 'second');
    const secondExit = await second.exited;

    // Then
    assert.deepEqual([firstExit.code, secondExit.code], [0, 0]);
  } finally {
    await Promise.all([stop(first, root, 'first'), stop(second, root, 'second')]);
    rmSync(root, { recursive: true, force: true });
  }
});

test('verify owner forwards graceful signals once and releases only after its group exits', async () => {
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    // Given
    const root = mkdtempSync(path.join(tmpdir(), 'chatmux-verify-owner-signal-'));
    const lockPath = path.join(root, 'verify.lock');
    let owner; let next;
    try {
      const started = armCreated(root, 'started-first'); owner = spawnOwner(lockPath, root, 'first'); await started;
      const signaled = armCreated(root, 'signaled-first');

      // When
      owner.child.kill(signal);
      const [ownerExit] = await Promise.all([owner.exited, signaled]);
      const nextStarted = armCreated(root, 'started-second'); next = spawnOwner(lockPath, root, 'second'); await nextStarted;
      release(root, 'second'); const nextExit = await next.exited;

      // Then
      assert.equal(ownerExit.signal, signal); assert.equal(nextExit.code, 0); assert.equal(existsSync(path.join(root, 'active')), false);
    } finally {
      await Promise.all([stop(owner, root, 'first'), stop(next, root, 'second')]);
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('SIGKILL orphan child keeps contenders waiting until the exact child exit event', async () => {
  // Given
  const root = mkdtempSync(path.join(tmpdir(), 'chatmux-verify-owner-kill-'));
  const lockPath = path.join(root, 'verify.lock');
  let first; let second;
  try {
    const firstStarted = armCreated(root, 'started-first'); first = spawnOwner(lockPath, root, 'first'); await firstStarted;
    first.child.kill('SIGKILL'); const firstExit = await first.exited; assert.equal(firstExit.signal, 'SIGKILL');
    second = spawnOwner(lockPath, root, 'second'); await second.waitForEvent('waiting');
    assert.equal(existsSync(path.join(root, 'started-second')), false);

    // When
    const secondStarted = armCreated(root, 'started-second'); release(root, 'first'); await secondStarted;
    release(root, 'second'); const secondExit = await second.exited;

    // Then
    assert.equal(secondExit.code, 0);
  } finally {
    await Promise.all([stop(first, root, 'first'), stop(second, root, 'second')]);
    rmSync(root, { recursive: true, force: true });
  }
});
