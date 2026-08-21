#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { access, mkdir, readFile, statfs, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  DEFAULT_TARGET_UBUNTU_VERSION,
  deriveUpgradeStatus,
} from './os-preflight-status.mjs';

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, '../..');
const outputRoot = path.resolve(
  process.env.CUA_EVIDENCE_DIR
    ?? path.join(repositoryRoot, '.omo', 'cua', 'os-preflight'),
);

async function run(file, args, options = {}) {
  try {
    const result = await execFileAsync(file, args, {
      cwd: repositoryRoot,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      timeout: 30_000,
      ...options,
    });
    return { ok: true, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      ok: false,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? '',
      exitCode: error.code ?? null,
    };
  }
}

const osRelease = Object.fromEntries(
  (await readFile('/etc/os-release', 'utf8'))
    .split('\n')
    .filter((line) => line.includes('='))
    .map((line) => {
      const separator = line.indexOf('=');
      return [line.slice(0, separator), line.slice(separator + 1).replace(/^"|"$/g, '')];
    }),
);
const [
  gnome,
  holds,
  dpkgAudit,
  failedUnits,
  releaseCheck,
  sudoCheck,
  gitStatus,
  tmuxSessions,
  filesystem,
] = await Promise.all([
  run('gnome-shell', ['--version']),
  run('apt-mark', ['showhold']),
  run('dpkg', ['--audit']),
  run('systemctl', ['--failed', '--no-legend', '--plain']),
  run('do-release-upgrade', ['-c']),
  run('sudo', ['-n', 'true']),
  run('git', ['status', '--porcelain']),
  run('tmux', ['list-sessions']),
  statfs('/'),
]);
let rebootRequired = false;
try {
  await access('/var/run/reboot-required');
  rebootRequired = true;
} catch {
  // No pending reboot marker.
}
const targetVersion = releaseCheck.stdout.match(/New release ['"]([^'"]+)['"]/)?.[1]
  ?? releaseCheck.stdout.match(/Ubuntu ([0-9.]+) LTS/)?.[1]
  ?? null;
const freeBytes = filesystem.bavail * filesystem.bsize;
const gates = {
  freeBytes,
  packageHolds: holds.stdout.split('\n').filter(Boolean).length,
  dpkgAuditEntries: dpkgAudit.stdout.split('\n').filter(Boolean).length,
  failedSystemUnits: failedUnits.stdout.split('\n').filter(Boolean).length,
  rebootRequired,
  gitChanges: gitStatus.stdout.split('\n').filter(Boolean).length,
  tmuxSessions: tmuxSessions.ok
    ? tmuxSessions.stdout.split('\n').filter(Boolean).length
    : 0,
  nonInteractiveSudo: sudoCheck.ok,
};
const upgradeStatus = deriveUpgradeStatus({
  currentVersion: osRelease.VERSION_ID,
  desiredVersion: process.env.CUA_TARGET_UBUNTU_VERSION
    ?? DEFAULT_TARGET_UBUNTU_VERSION,
  targetAvailable: releaseCheck.ok && Boolean(targetVersion),
  gates,
});
const report = {
  capturedAt: new Date().toISOString(),
  current: {
    os: osRelease.PRETTY_NAME,
    versionId: osRelease.VERSION_ID,
    gnome: gnome.stdout.trim() || null,
  },
  target: {
    available: releaseCheck.ok && Boolean(targetVersion),
    version: targetVersion,
    desiredVersion: upgradeStatus.desiredVersion,
    reached: upgradeStatus.reachedTarget,
  },
  gates,
};
report.readyForAuthorizedUpgrade = upgradeStatus.readyForAuthorizedUpgrade;
report.upgradeComplete = upgradeStatus.upgradeComplete;
report.blocked = upgradeStatus.blocked;
report.blocker = upgradeStatus.blocker;
await mkdir(outputRoot, { recursive: true });
const outputPath = path.join(outputRoot, 'os-preflight.json');
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify({ outputPath, ...report }, null, 2)}\n`);
