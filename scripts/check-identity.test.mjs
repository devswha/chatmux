import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  classifyDirectoryEntry,
  findForbiddenReleaseDependencies,
  findForbiddenReleaseInvocation,
  isForbiddenReleaseConfig,
} from './check-identity.mjs';

async function withTemporaryDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), 'check-identity-'));
  t.after(() => rm(directory, { force: true, recursive: true }));
  return directory;
}

async function directoryEntry(directory, name) {
  const entry = (await readdir(directory, { withFileTypes: true })).find((candidate) => candidate.name === name);
  assert.ok(entry, `Expected ${name} in ${directory}`);
  return entry;
}

test('skips skipped directories', async (t) => {
  const directory = await withTemporaryDirectory(t);
  await Promise.all(['.git', '.insane-review', '.omo'].map((name) => mkdir(join(directory, name))));

  assert.equal(classifyDirectoryEntry(await directoryEntry(directory, '.git'), '.git'), 'skip');
  assert.equal(classifyDirectoryEntry(await directoryEntry(directory, '.insane-review'), '.insane-review'), 'skip');
  assert.equal(classifyDirectoryEntry(await directoryEntry(directory, '.omo'), '.omo'), 'skip');
});

test('scans regular files with skipped-directory names', async (t) => {
  const directory = await withTemporaryDirectory(t);
  await writeFile(join(directory, 'node_modules'), 'identity');

  assert.equal(classifyDirectoryEntry(await directoryEntry(directory, 'node_modules'), 'node_modules'), 'scan');
});

test('rejects non-.codegraph skipped-name symlinks', async (t) => {
  const directory = await withTemporaryDirectory(t);
  await mkdir(join(directory, 'target'));
  await symlink('target', join(directory, '.git'));

  assert.equal(classifyDirectoryEntry(await directoryEntry(directory, '.git'), '.git'), 'reject');
});

test('accepts only the root .codegraph symlink as metadata', async (t) => {
  const directory = await withTemporaryDirectory(t);
  await mkdir(join(directory, 'target'));
  await symlink('target', join(directory, '.codegraph'));

  assert.equal(classifyDirectoryEntry(await directoryEntry(directory, '.codegraph'), '.codegraph'), 'skip');
});

test('rejects nested .codegraph symlinks', async (t) => {
  const directory = await withTemporaryDirectory(t);
  await mkdir(join(directory, 'nested'));
  await mkdir(join(directory, 'target'));
  await symlink('../target', join(directory, 'nested', '.codegraph'));

  assert.equal(
    classifyDirectoryEntry(await directoryEntry(join(directory, 'nested'), '.codegraph'), 'nested/.codegraph'),
    'reject',
  );
});

test('rejects release-it configuration files', () => {
  assert.equal(isForbiddenReleaseConfig('.release-it'), true);
  assert.equal(isForbiddenReleaseConfig('.release-it.json'), true);
  assert.equal(isForbiddenReleaseConfig('.release-it.cjs'), true);
  assert.equal(isForbiddenReleaseConfig('config/.release-it.json'), true);
  assert.equal(isForbiddenReleaseConfig('release-it.json'), false);
});

test('rejects release-it command invocations only in executable script entrypoints', () => {
  assert.match(findForbiddenReleaseInvocation('release.sh', 'exec npx release-it "$@"'), /release-it/u);
  assert.match(findForbiddenReleaseInvocation('scripts/publish.mjs', "spawn('release-it', args)"), /release-it/u);
  assert.equal(findForbiddenReleaseInvocation('CHANGELOG.md', 'npx release-it'), null);
  assert.equal(findForbiddenReleaseInvocation('scripts/check-identity.test.mjs', 'npx release-it'), null);
});

test('rejects a release-it package configuration key', () => {
  assert.deepEqual(findForbiddenReleaseDependencies({ 'release-it': {} }, {}), [
    'package.json release-it: forbidden release-it configuration key',
  ]);
});

test('rejects npm aliases that resolve to release-it in every dependency section', () => {
  const violations = findForbiddenReleaseDependencies(
    {
      dependencies: { publisher: 'npm:release-it' },
      optionalDependencies: { optionalPublisher: 'npm:release-it@20.2.1' },
    },
    {
      packages: {
        '': { peerDependencies: { peerPublisher: 'npm:release-it@^20' } },
      },
    },
  );

  assert.deepEqual(violations, [
    'package.json dependencies.publisher: forbidden npm alias to release-it',
    'package.json optionalDependencies.optionalPublisher: forbidden npm alias to release-it',
    'package-lock.json root peerDependencies.peerPublisher: forbidden npm alias to release-it',
  ]);
});

test('rejects obsolete release dependencies from manifests and lock packages', () => {
  const violations = findForbiddenReleaseDependencies(
    {
      dependencies: { 'auto-changelog': '^2.5.0' },
      devDependencies: { 'release-it': '^20.2.1' },
    },
    {
      packages: {
        '': {
          peerDependencies: {
            '@release-it/conventional-changelog': '^11.0.1',
          },
        },
        'node_modules/example/node_modules/release-it': {},
      },
    },
  );

  assert.deepEqual(violations, [
    'package.json dependencies.auto-changelog: forbidden release-it dependency',
    'package.json devDependencies.release-it: forbidden release-it dependency',
    'package-lock.json root peerDependencies.@release-it/conventional-changelog: forbidden release-it dependency',
    'package-lock.json node_modules/example/node_modules/release-it: forbidden release-it dependency',
  ]);
});
