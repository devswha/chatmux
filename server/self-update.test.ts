import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildSelfUpdateScript,
  buildSystemdRunArgs,
  detectInstallMode,
  planSelfUpdate,
  SELF_UPDATE_STALE_MS,
  shellQuote,
} from './self-update.js';

function tempRoot(): string {
  return mkdtempSync(path.join(tmpdir(), 'self-update-'));
}

test('detectInstallMode: git checkout with deploy tooling is source', () => {
  const root = tempRoot();
  mkdirSync(path.join(root, '.git'));
  mkdirSync(path.join(root, 'scripts'));
  writeFileSync(path.join(root, 'scripts', 'deploy.sh'), '#!/usr/bin/env bash\n');
  assert.equal(detectInstallMode(root, tempRoot()), 'source');
});

test('detectInstallMode: an unpacked release under ~/.chatmux/releases is release', () => {
  const home = tempRoot();
  const releaseRoot = path.join(home, '.chatmux', 'releases', '1.0.0');
  mkdirSync(releaseRoot, { recursive: true });
  // Even with git/deploy.sh present, the release location wins — the artifact
  // contract (checksum-verified cutover) must not be bypassed by one click.
  mkdirSync(path.join(releaseRoot, '.git'));
  mkdirSync(path.join(releaseRoot, 'scripts'));
  writeFileSync(path.join(releaseRoot, 'scripts', 'deploy.sh'), '');
  assert.equal(detectInstallMode(releaseRoot, home), 'release');
});

test('detectInstallMode: a bare directory without tooling is unknown', () => {
  const root = tempRoot();
  assert.equal(detectInstallMode(root, tempRoot()), 'unknown');
  const gitOnly = tempRoot();
  mkdirSync(path.join(gitOnly, '.git'));
  assert.equal(detectInstallMode(gitOnly, tempRoot()), 'unknown', 'a checkout without deploy.sh cannot self-update');
});

test('planSelfUpdate: only source mode may start; release and unknown fail closed', () => {
  const now = 1_000_000;
  assert.deepEqual(planSelfUpdate({ mode: 'source', inFlight: null, now }), { action: 'start' });

  const release = planSelfUpdate({ mode: 'release', inFlight: null, now });
  assert.equal(release.action, 'reject');
  assert.equal(release.action === 'reject' && release.statusCode, 409);

  const unknown = planSelfUpdate({ mode: 'unknown', inFlight: null, now });
  assert.equal(unknown.action, 'reject');
  assert.equal(unknown.action === 'reject' && unknown.statusCode, 409);
});

test('planSelfUpdate: single-flight rejects a concurrent start but a stale marker expires', () => {
  const startedAt = 1_000_000;
  const running = planSelfUpdate({ mode: 'source', inFlight: { unit: 'u', startedAt }, now: startedAt + 60_000 });
  assert.equal(running.action, 'reject');
  assert.equal(running.action === 'reject' && running.statusCode, 429);

  const afterStale = planSelfUpdate({
    mode: 'source',
    inFlight: { unit: 'u', startedAt },
    now: startedAt + SELF_UPDATE_STALE_MS + 1,
  });
  assert.deepEqual(afterStale, { action: 'start' }, 'a crashed updater must not wedge the button forever');
});

test('buildSelfUpdateScript: ff-only pull, conditional npm ci, deploy.sh with the health url', () => {
  const script = buildSelfUpdateScript('/srv/app dir', 'http://127.0.0.1:3021/', '/home/u/.chatmux/self-update.log');
  assert.ok(script.includes("cd '/srv/app dir'"), 'app root is shell-quoted');
  assert.ok(script.includes('git pull --ff-only origin main'), 'never merges or rebases on its own');
  assert.ok(/if ! git diff --quiet .* -- package-lock\.json; then npm ci; fi/.test(script),
    'node_modules is only reinstalled when the pull changed dependencies');
  assert.ok(script.includes("DEPLOY_HEALTH_URL='http://127.0.0.1:3021/' scripts/deploy.sh"),
    'hands over to the verified deploy machinery (build → restart → health → rollback)');
  assert.ok(script.startsWith("exec >>'/home/u/.chatmux/self-update.log' 2>&1"), 'output lands in the log file');
  assert.ok(script.includes('set -euo pipefail'), 'any failing step stops the update');
  assert.ok(script.includes('export PATH="$HOME/.cargo/bin:$HOME/.local/bin:$PATH"'),
    'the transient unit must reach cargo for the native-core build (실측 ENOENT)');
});

test('buildSystemdRunArgs: detached transient unit with the caller PATH', () => {
  const args = buildSystemdRunArgs('chatmux-self-update-1', 'echo hi', '/usr/bin:/bin');
  assert.deepEqual(args.slice(0, 3), ['--user', '--collect', '--unit=chatmux-self-update-1']);
  assert.ok(args.includes('--setenv=PATH=/usr/bin:/bin'), 'nvm-provided node must be reachable in the unit');
  assert.deepEqual(args.slice(-3), ['bash', '-c', 'echo hi']);
});

test('shellQuote survives embedded single quotes', () => {
  assert.equal(shellQuote("a'b"), `'a'\\''b'`);
});
