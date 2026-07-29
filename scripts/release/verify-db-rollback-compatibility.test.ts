import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  canonicalAssets,
  declaredRollbackVersions,
  proveRollbackCompatibility,
  verifyChecksum,
} from './verify-db-rollback-compatibility.mjs';

const declaration = {
  schema: 1,
  releases: {
    '1.4.4': { database: { rollbackCompatibleFrom: ['1.4.3'] } },
  },
};

test('uses only exact canonical old release asset names', () => {
  assert.deepEqual(canonicalAssets('1.4.3'), {
    archiveName: 'chatmux-server-1.4.3-linux-x64-node22.tar.gz',
    checksumName: 'chatmux-server-1.4.3-linux-x64-node22.tar.gz.sha256',
  });
  assert.throws(() => canonicalAssets('^1.4.3'));
  assert.throws(() => declaredRollbackVersions({ schema: 1, releases: {} }, '1.4.4'));
});

test('rejects non-canonical or mismatched checksums', () => {
  const archive = Buffer.from('old release');
  const digest = '05d3a835ff4f5e5138805558c46f0daaae88b7b7806e4b99349e11fe1f6621ea';
  assert.doesNotThrow(() => verifyChecksum(`${digest}  chatmux-server-1.4.3-linux-x64-node22.tar.gz\n`, archive, 'chatmux-server-1.4.3-linux-x64-node22.tar.gz'));
  assert.throws(() => verifyChecksum(`${digest} *chatmux-server-1.4.3-linux-x64-node22.tar.gz\n`, archive, 'chatmux-server-1.4.3-linux-x64-node22.tar.gz'));
});

test('proves each explicitly declared version by migration, old boot, exact health, and representative read/write', async () => {
  const events: string[] = [];
  const archive = Buffer.from('old release');
  const digest = '05d3a835ff4f5e5138805558c46f0daaae88b7b7806e4b99349e11fe1f6621ea';
  const result = await proveRollbackCompatibility({
    targetVersion: '1.4.4',
    declaration,
    fetchExactAsset: async (version, name) => {
      events.push(`fetch:${version}:${name}`);
      return name.endsWith('.sha256') ? `${digest}  chatmux-server-1.4.3-linux-x64-node22.tar.gz\n` : archive;
    },
    extractSafely: async ({ version }) => { events.push(`extract:${version}`); return '/old'; },
    copyRepresentativeDatabase: async () => { events.push('copy-db'); return '/db'; },
    runTargetMigrations: async () => { events.push('migrate'); },
    bootOldRuntime: async () => ({ stop: async () => { events.push('stop'); } }),
    assertHealth: async ({ version }) => { events.push(`health:${version}`); return { product: 'chatmux', status: 'ok', version }; },
    exerciseRepresentativeRead: async ({ version }) => { events.push(`read:${version}`); return { token: 'old-token' }; },
    exerciseRepresentativeWrite: async ({ version, session }) => { assert.deepEqual(session, { token: 'old-token' }); events.push(`write:${version}`); },
  });
  assert.deepEqual(result, { targetVersion: '1.4.4', proven: ['1.4.3'] });
  assert.deepEqual(events, [
    'fetch:1.4.3:chatmux-server-1.4.3-linux-x64-node22.tar.gz',
    'fetch:1.4.3:chatmux-server-1.4.3-linux-x64-node22.tar.gz.sha256',
    'extract:1.4.3', 'copy-db', 'migrate', 'health:1.4.3', 'read:1.4.3', 'write:1.4.3', 'stop',
  ]);
});

test('propagates old-runtime representative write failure and still stops the runtime', async () => {
  const archive = Buffer.from('old release');
  const digest = '05d3a835ff4f5e5138805558c46f0daaae88b7b7806e4b99349e11fe1f6621ea';
  let stopped = false;
  await assert.rejects(proveRollbackCompatibility({
    targetVersion: '1.4.4', declaration,
    fetchExactAsset: async (_version, name) => name.endsWith('.sha256') ? `${digest}  chatmux-server-1.4.3-linux-x64-node22.tar.gz\n` : archive,
    extractSafely: async () => '/old', copyRepresentativeDatabase: async () => '/db',
    runTargetMigrations: async () => undefined, bootOldRuntime: async () => ({ stop: async () => { stopped = true; } }),
    assertHealth: async () => ({ product: 'chatmux', status: 'ok', version: '1.4.3' }), exerciseRepresentativeRead: async () => ({ token: 'old-token' }),
    exerciseRepresentativeWrite: async () => { throw new Error('logout write failed'); },
  }), /logout write failed/);
  assert.equal(stopped, true);
});
test('rejects old-runtime health that is not the exact ChatMux old release', async () => {
  const archive = Buffer.from('old release');
  const digest = '05d3a835ff4f5e5138805558c46f0daaae88b7b7806e4b99349e11fe1f6621ea';
  await assert.rejects(proveRollbackCompatibility({
    targetVersion: '1.4.4', declaration,
    fetchExactAsset: async (_version, name) => name.endsWith('.sha256') ? `${digest}  chatmux-server-1.4.3-linux-x64-node22.tar.gz\n` : archive,
    extractSafely: async () => '/old', copyRepresentativeDatabase: async () => '/db',
    runTargetMigrations: async () => undefined, bootOldRuntime: async () => ({ stop: async () => undefined }),
    assertHealth: async () => ({ product: 'other', status: 'ok', version: '1.4.3' }),
    exerciseRepresentativeRead: async () => ({ token: 'unreachable' }),
    exerciseRepresentativeWrite: async () => undefined,
  }), /health identity/);
});
