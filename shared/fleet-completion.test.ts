import assert from 'node:assert/strict';
import test from 'node:test';

import {
  completionEventIdentityKey,
  parseFleetCompletionReady,
} from './fleet-completion.js';

const HOST_A = '11111111-1111-4111-8111-111111111111';
const HOST_B = '22222222-2222-4222-8222-222222222222';

function app(hostId: string) {
  return {
    version: 'completion/1',
    target: { kind: 'app', hostId, localId: 'same-session' },
    provider: 'claude',
    occurrenceKey: 'same-turn',
    preferenceClass: 'stop',
    hostLabel: hostId === HOST_A ? 'studio-a' : 'studio-b',
    sessionLabel: 'Agent',
  } as const;
}

test('Given equal app IDs on two installations, when identities are digested, then they never collide', () => {
  const first = parseFleetCompletionReady(app(HOST_A));
  const second = parseFleetCompletionReady(app(HOST_B));

  assert.notEqual(completionEventIdentityKey(first), completionEventIdentityKey(second));
});

test('Given app and pane generations share local IDs, when identities are digested, then target kinds never collide', () => {
  const appEvent = parseFleetCompletionReady(app(HOST_A));
  const paneEvent = parseFleetCompletionReady({
    ...app(HOST_A),
    target: {
      kind: 'pane_generation', hostId: HOST_A, lane: 'external', appLocalId: 'same-session',
      tmux: { sessionId: '$1', windowId: '@1', paneId: '%1' },
      process: { pid: 42, startedAtMs: 100 },
    },
    preferenceClass: 'liveStop',
  });

  assert.notEqual(completionEventIdentityKey(appEvent), completionEventIdentityKey(paneEvent));
});

test('Given an untrusted completion event, when sensitive or malformed fields appear, then parsing fails closed', () => {
  assert.throws(() => parseFleetCompletionReady({ ...app(HOST_A), transcriptPath: '/secret' }), /unexpected fields/);
  assert.throws(() => parseFleetCompletionReady({ ...app(HOST_A), target: { ...app(HOST_A).target, hostId: 'local' } }), /hostId/);
  assert.throws(() => parseFleetCompletionReady({ ...app(HOST_A), hostLabel: 'x'.repeat(81) }), /hostLabel/);
  assert.throws(() => parseFleetCompletionReady({
    ...app(HOST_A),
    target: {
      kind: 'pane_generation', hostId: HOST_A, lane: 'external', appLocalId: null,
      tmux: { socketPath: '/secret', sessionId: '$1', windowId: '@1', paneId: '%1' },
      process: { pid: 42, startedAtMs: 100 },
    },
  }), /unexpected fields/);
});
