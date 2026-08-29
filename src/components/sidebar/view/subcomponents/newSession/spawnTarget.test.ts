import assert from 'node:assert/strict';
import test from 'node:test';

import type { SpawnHostChoice } from '../../../../../fleet/hostAvailability';

import {
  canDispatchSpawn,
  classifyRemoteSpawn,
  peerRelativeCwd,
} from './spawnTarget';

const LOCAL_HOST: SpawnHostChoice = { hostId: '11111111-1111-4111-8111-111111111111', label: 'This machine', isLocal: true };
const PEER_HOST: SpawnHostChoice = { hostId: '22222222-2222-4222-8222-222222222222', label: 'studio', isLocal: false };

test('Given a controller-style path, when a peer working directory is parsed, then it is refused', () => {
  // Given / When / Then
  assert.equal(peerRelativeCwd('/home/devswha/workspace/chatmux'), null);
  assert.equal(peerRelativeCwd('~/workspace/chatmux'), null);
  assert.equal(peerRelativeCwd('workspace/../../etc'), null);
  assert.equal(peerRelativeCwd('   '), null);
});

test('Given a home-relative path, when a peer working directory is parsed, then it is kept without a trailing slash', () => {
  // Given / When / Then
  assert.equal(peerRelativeCwd(' workspace/chatmux/ '), 'workspace/chatmux');
  assert.equal(peerRelativeCwd('workspace'), 'workspace');
});

test('Given a peer host, when the form has no project, then the spawn cannot be dispatched', () => {
  // Given / When / Then
  assert.equal(canDispatchSpawn({ host: PEER_HOST, name: 'feature', cwd: 'workspace/app', projectLocalId: null }), false);
  assert.equal(canDispatchSpawn({ host: PEER_HOST, name: 'feature', cwd: 'workspace/app', projectLocalId: 'project-1' }), true);
});

test('Given a peer host, when the path is absolute, then the spawn cannot be dispatched', () => {
  // Given / When / Then
  assert.equal(canDispatchSpawn({ host: PEER_HOST, name: 'feature', cwd: '/srv/app', projectLocalId: 'project-1' }), false);
});

test('Given the local host, when an absolute path is entered, then the spawn is still dispatchable', () => {
  // Given / When / Then
  assert.equal(canDispatchSpawn({ host: LOCAL_HOST, name: 'feature', cwd: '/home/me/app', projectLocalId: null }), true);
  assert.equal(canDispatchSpawn({ host: LOCAL_HOST, name: '', cwd: '/home/me/app', projectLocalId: null }), false);
});

test('Given a dispatched spawn with no answer, when the result is classified, then the outcome is unknown rather than a failure', () => {
  // Given / When
  const outcome = classifyRemoteSpawn(
    { ok: false, failure: { code: 'HOST_REQUEST_FAILED', message: 'socket closed', outcome: 'unknown' } },
    'workspace/app',
  );

  // Then
  assert.deepEqual(outcome, { kind: 'unknown' });
});

test('Given an explicit uncertain host code, when the result is classified, then the outcome is unknown', () => {
  // Given / When
  const outcome = classifyRemoteSpawn(
    { ok: false, failure: { code: 'HOST_COMMAND_OUTCOME_UNKNOWN', message: 'peer dropped', outcome: 'none' } },
    'workspace/app',
  );

  // Then
  assert.deepEqual(outcome, { kind: 'unknown' });
});

test('Given an offline host, when the result is classified, then it is a plain rejection with no side effect', () => {
  // Given / When
  const outcome = classifyRemoteSpawn(
    { ok: false, failure: { code: 'HOST_OFFLINE', message: 'peer offline', outcome: 'none' } },
    'workspace/app',
  );

  // Then
  assert.deepEqual(outcome, { kind: 'rejected', reason: 'tower-unavailable', detail: null });
});

test('Given each peer spawn body, when the result is classified, then success, conflict and unreachable stay distinct', () => {
  // Given / When / Then
  assert.deepEqual(
    classifyRemoteSpawn({ ok: true, value: { ok: true, reachable: true, conflict: false } }, 'workspace/app'),
    { kind: 'created', cwd: 'workspace/app' },
  );
  assert.deepEqual(
    classifyRemoteSpawn({ ok: true, value: { ok: false, reachable: true, conflict: true } }, 'workspace/app'),
    { kind: 'rejected', reason: 'name-conflict', detail: null },
  );
  assert.deepEqual(
    classifyRemoteSpawn({ ok: true, value: { ok: false, reachable: false, conflict: false } }, 'workspace/app'),
    { kind: 'rejected', reason: 'tower-unavailable', detail: null },
  );
  assert.deepEqual(
    classifyRemoteSpawn({ ok: true, value: null }, 'workspace/app'),
    { kind: 'rejected', reason: 'failed', detail: null },
  );
});
