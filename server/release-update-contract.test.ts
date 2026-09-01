import assert from 'node:assert/strict';
import test from 'node:test';

import {
  archiveNameForVersion,
  compareStrictSemVer,
  parseStrictSemVer,
  sanitizePublicUpdateError,
  validateCompatibilityMetadata,
  validateImmutableUpdateJobDescriptor,
  validateReleaseDescriptor,
} from './release-update-contract.js';

const checksum = 'a'.repeat(64);
const release = {
  repository: 'devswha/chatmux', tag: 'v1.2.3', version: '1.2.3',
  archiveName: 'chatmux-server-1.2.3-linux-x64-node22.tar.gz',
  checksumName: 'chatmux-server-1.2.3-linux-x64-node22.tar.gz.sha256',
  bootstrapName: 'install.sh', archiveSha256: checksum, publishedAt: '2026-01-02T03:04:05.000Z',
};

test('strict SemVer accepts only stable numeric X.Y.Z versions', () => {
  assert.deepEqual(parseStrictSemVer('1.2.3'), { major: 1, minor: 2, patch: 3, version: '1.2.3' });
  for (const invalid of ['v1.2.3', '01.2.3', '1.02.3', '1.2.03', '1.2', '1.2.3-rc.1', '1.2.3+build', '1.2.3 ', '1.2.3.4']) assert.equal(parseStrictSemVer(invalid), null);
  assert.equal(compareStrictSemVer('1.2.3', '1.2.4'), -1);
  assert.equal(compareStrictSemVer('1.2.3-rc.1', '1.2.3'), null);
  assert.equal(compareStrictSemVer('1.2.99', '1.2.3'), 1);
  assert.equal(compareStrictSemVer('1.10.0', '1.2.99'), 1);
  assert.equal(compareStrictSemVer('2.0.0', '1.999.999'), 1);
  assert.equal(compareStrictSemVer('1.2.3', '1.2.3'), 0);
});

test('canonical release descriptor closes all release authority inputs', () => {
  assert.deepEqual(validateReleaseDescriptor(release), release);
  for (const mutation of [
    { ...release, repository: 'other/chatmux' }, { ...release, tag: '1.2.3' },
    { ...release, archiveName: 'chatmux-server-1.2.3-linux-arm64-node22.tar.gz' },
    { ...release, checksumName: 'checksum.txt' }, { ...release, bootstrapName: 'bootstrap.sh' },
    { ...release, archiveSha256: checksum.toUpperCase() }, { ...release, extra: 'selector' },
  ]) assert.equal(validateReleaseDescriptor(mutation), null);
  assert.equal(archiveNameForVersion('1.2.3'), release.archiveName);
  assert.equal(archiveNameForVersion('1.2.3-beta.1'), null);
});

test('immutable job descriptors and compatibility metadata are closed and exact', () => {
  const descriptor = { id: 'abcdefghijklmnopqrstuv', release, compatibility: { database: { rollbackCompatibleFrom: ['1.2.2'] } }, createdAt: 1, installMode: 'release', sourceVersion: '1.2.2', sourceBootId: 'boot-123', serverPort: 3000 };
  assert.ok(validateImmutableUpdateJobDescriptor(descriptor));
  assert.equal(validateImmutableUpdateJobDescriptor({ ...descriptor, id: 'short' }), null);
  assert.equal(validateImmutableUpdateJobDescriptor({ ...descriptor, installMode: 'remote' }), null);
  assert.equal(validateCompatibilityMetadata({ database: { rollbackCompatibleFrom: ['1.2.2', '1.2.2'] } }), null);
  assert.equal(validateCompatibilityMetadata({ database: { rollbackCompatibleFrom: ['1.2.2-rc.1'] } }), null);
  assert.deepEqual(
    validateCompatibilityMetadata({ database: { rollbackCompatibleFrom: ['1.2.2'], schemaGeneration: 19 } }),
    { database: { rollbackCompatibleFrom: ['1.2.2'] } },
    'the governance-only schemaGeneration field is accepted and stripped',
  );
  assert.equal(validateCompatibilityMetadata({ database: { rollbackCompatibleFrom: ['1.2.2'], schemaGeneration: -1 } }), null);
  assert.equal(validateCompatibilityMetadata({ database: { rollbackCompatibleFrom: ['1.2.2'], schemaGeneration: 1.5 } }), null);
  assert.equal(validateCompatibilityMetadata({ database: { rollbackCompatibleFrom: ['1.2.2'], schemaGeneration: '19' } }), null);
  assert.equal(validateCompatibilityMetadata({ database: { rollbackCompatibleFrom: ['1.2.2'], unexpected: true } }), null);
  for (const mutation of [
    { ...descriptor, sourceVersion: 'not-a-version' },
    { ...descriptor, sourceBootId: '' },
    { ...descriptor, sourceBootId: 'x'.repeat(201) },
    { ...descriptor, sourceBootId: 'boot\nid' },
    { ...descriptor, serverPort: 0 },
    { ...descriptor, serverPort: 65536 },
  ]) assert.equal(validateImmutableUpdateJobDescriptor(mutation), null);
});

test('public errors remove paths, urls, tokens, and control characters', () => {
  const error = sanitizePublicUpdateError('failed /home/me/.chatmux/current\nhttps://secret.example/x token=abc');
  assert.equal(error, 'failed [redacted] [redacted] [redacted]');
});
