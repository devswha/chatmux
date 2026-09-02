import assert from 'node:assert/strict';
import test from 'node:test';

import { createVerifiedTmuxActionTarget } from '@/modules/providers/index.js';

import { RemoteTerminalPeerError } from '../terminal/peer.js';
import { verifyLocalRemoteTerminalTarget } from '../terminal/local-peer.js';

const HOST = '123e4567-e89b-42d3-a456-426614174000';
const tmux = { socketPath: '/tmp/tmux-1000/default', sessionId: '$1', windowId: '@1', paneId: '%1' } as const;
const process = { pid: 42, startedAtMs: 100 } as const;
const reference = { kind: 'pane', hostId: HOST, localId: 'pane-1', lane: 'external', tmux, process } as const;

test('fleet terminal attach refuses a protected company* pane like local attach and fleet mutations do', async () => {
  const verifiers = {
    external: async () => createVerifiedTmuxActionTarget(tmux, process, 'codex', 'company-ops', null),
    live: async () => createVerifiedTmuxActionTarget(tmux, process, 'gjc', 'company-ops', null),
  };
  await assert.rejects(verifyLocalRemoteTerminalTarget(reference, verifiers), (error: unknown) => error instanceof RemoteTerminalPeerError && error.code === 'FLEET_UNAUTHORIZED');
  await assert.rejects(verifyLocalRemoteTerminalTarget({ ...reference, lane: 'live' }, verifiers), (error: unknown) => error instanceof RemoteTerminalPeerError && error.code === 'FLEET_UNAUTHORIZED');

  const plain = {
    external: async () => createVerifiedTmuxActionTarget(tmux, process, 'codex', 'agent-1', null),
    live: async () => createVerifiedTmuxActionTarget(tmux, process, 'gjc', 'agent-1', null),
  };
  assert.deepEqual(await verifyLocalRemoteTerminalTarget(reference, plain), reference);
});
