import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const repositoryRoot = process.cwd();
const installerPath = path.join(repositoryRoot, 'install.sh');

async function createReleaseFixture(root: string, version: string, checksum = 'valid') {
  const payload = path.join(root, 'payload');
  const release = path.join(root, 'releases', `v${version}`);
  const artifact = `chatmux-server-${version}-linux-x64-node22.tar.gz`;
  await fs.mkdir(path.join(payload, 'scripts'), { recursive: true });
  await fs.mkdir(release, { recursive: true });
  await fs.writeFile(path.join(payload, 'scripts', 'chatmux-runtime.mjs'), [
    "import fs from 'node:fs';",
    "fs.writeFileSync(process.env.CHATMUX_TEST_CAPTURE, JSON.stringify(process.argv.slice(2)));",
  ].join('\n'));

  const archivePath = path.join(release, artifact);
  const tar = spawnSync('tar', ['-czf', archivePath, '-C', payload, '.'], { encoding: 'utf8' });
  assert.equal(tar.status, 0, tar.stderr);
  const digest = createHash('sha256').update(await fs.readFile(archivePath)).digest('hex');
  await fs.writeFile(
    `${archivePath}.sha256`,
    `${checksum === 'valid' ? digest : '0'.repeat(64)}  ${artifact}\n`,
  );
  return path.join(root, 'releases');
}

async function createNodeFixture(root: string) {
  const version = '22.22.2';
  const directoryName = `node-v${version}-linux-x64`;
  const payload = path.join(root, 'node-payload', directoryName);
  const base = path.join(root, 'node-release');
  const archive = `${directoryName}.tar.xz`;
  await fs.mkdir(path.join(payload, 'bin'), { recursive: true });
  await fs.mkdir(base, { recursive: true });
  await fs.writeFile(path.join(payload, 'bin', 'node'), [
    '#!/bin/sh',
    'if [ "${1:-}" = "-p" ]; then printf "%s\\n" "22.22.2"; exit 0; fi',
    `exec ${JSON.stringify(process.execPath)} "$@"`,
  ].join('\n'), { mode: 0o755 });
  const archivePath = path.join(base, archive);
  const tar = spawnSync('tar', ['-cJf', archivePath, '-C', path.dirname(payload), directoryName], {
    encoding: 'utf8',
  });
  assert.equal(tar.status, 0, tar.stderr);
  const digest = createHash('sha256').update(await fs.readFile(archivePath)).digest('hex');
  await fs.writeFile(path.join(base, 'SHASUMS256.txt'), `${digest}  ${archive}\n`);
  return base;
}


test('one-line bootstrap verifies, installs, and reuses a pinned release', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmux-bootstrap-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const capture = path.join(root, 'args.json');
  const version = '9.9.9';
  const releaseBase = await createReleaseFixture(root, version);
  const env = {
    ...process.env,
    HOME: home,
    CHATMUX_VERSION: version,
    CHATMUX_RELEASE_BASE_URL: `file://${releaseBase}`,
    CHATMUX_NODE: process.execPath,
    CHATMUX_TEST_CAPTURE: capture,
  };

  const first = spawnSync('bash', [installerPath, '--local'], { encoding: 'utf8', env });
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(JSON.parse(await fs.readFile(capture, 'utf8')), ['install', '--yes', '--local']);
  assert.equal(
    await fs.realpath(path.join(home, '.chatmux', 'releases', version, 'scripts', 'chatmux-runtime.mjs')),
    path.join(home, '.chatmux', 'releases', version, 'scripts', 'chatmux-runtime.mjs'),
  );

  await fs.rm(releaseBase, { recursive: true, force: true });
  const second = spawnSync('bash', [installerPath, '--local'], { encoding: 'utf8', env });
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stderr, /Reusing verified ChatMux 9\.9\.9 payload/);
});

test('one-line bootstrap installs a private Node 22 runtime when the host Node is unsupported', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmux-bootstrap-node-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const fakeBin = path.join(root, 'bin');
  const version = '9.9.7';
  const releaseBase = await createReleaseFixture(root, version);
  const nodeBase = await createNodeFixture(root);
  const capture = path.join(root, 'args.json');
  await fs.mkdir(fakeBin, { recursive: true });
  await fs.writeFile(path.join(fakeBin, 'node'), [
    '#!/bin/sh',
    'if [ "${1:-}" = "-p" ]; then printf "%s\\n" "24.18.0"; exit 0; fi',
    'exit 1',
  ].join('\n'), { mode: 0o755 });

  const result = spawnSync('bash', [installerPath, '--local'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      PATH: `${fakeBin}:${process.env.PATH}`,
      CHATMUX_VERSION: version,
      CHATMUX_RELEASE_BASE_URL: `file://${releaseBase}`,
      CHATMUX_NODE_BASE_URL: `file://${nodeBase}`,
      CHATMUX_TEST_CAPTURE: capture,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /installing a private runtime/);
  await fs.access(path.join(home, '.chatmux', 'runtime', 'node-v22.22.2', 'bin', 'node'));
  assert.deepEqual(JSON.parse(await fs.readFile(capture, 'utf8')), ['install', '--yes', '--local']);
});

test('one-line bootstrap rejects a release with a mismatched checksum', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmux-bootstrap-bad-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const version = '9.9.8';
  const releaseBase = await createReleaseFixture(root, version, 'invalid');
  const home = path.join(root, 'home');
  const result = spawnSync('bash', [installerPath, '--local'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      CHATMUX_VERSION: version,
      CHATMUX_RELEASE_BASE_URL: `file://${releaseBase}`,
      CHATMUX_NODE: process.execPath,
      CHATMUX_TEST_CAPTURE: path.join(root, 'args.json'),
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /checksum verification failed/);
  await assert.rejects(fs.access(path.join(home, '.chatmux', 'releases', version)));
});
