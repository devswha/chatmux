import assert from 'node:assert/strict';
import test from 'node:test';

import { buildExternalAttachTarget, buildTranscriptCliAttachTarget } from './externalAttachTargets';

const remote = {
  hostId: '22222222-2222-4222-8222-222222222222',
  hostLabel: 'Peer A',
  lane: 'external' as const,
  localId: 'collision-pane',
  tmuxName: 'agent',
  tmux: { socketPath: '/tmp/peer.sock', sessionId: '$1', windowId: '@1', paneId: '%1' },
  process: { pid: 41, startedAtMs: 8_000 },
  kind: 'Codex',
  cliKind: 'codex' as const,
  project: null,
};

const expectedTarget = {
  kind: 'pane' as const,
  hostId: remote.hostId,
  localId: remote.localId,
  lane: remote.lane,
  tmux: remote.tmux,
  process: remote.process,
};

test('Given a host-qualified pane, when terminal attach is built, then host and process generation remain exact', () => {
  assert.deepEqual(buildExternalAttachTarget(remote), {
    targetClass: 'remote-agent', target: expectedTarget,
  });
});

test('Given a host-qualified transcript pane, when its CLI tab attaches, then it cannot fall back to local tmux', () => {
  assert.deepEqual(buildTranscriptCliAttachTarget(remote), {
    targetClass: 'remote-agent', target: expectedTarget,
  });
});
