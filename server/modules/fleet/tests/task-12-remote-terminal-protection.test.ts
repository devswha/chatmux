import assert from 'node:assert/strict';
import test from 'node:test';

import { assertFreshExternalTmuxTarget, assertLineageTmuxTarget } from '@/modules/providers/index.js';

import { RemoteTerminalPeerError } from '../terminal/peer.js';
import { verifyLocalRemoteTerminalTarget } from '../terminal/local-peer.js';

const HOST = '123e4567-e89b-42d3-a456-426614174000';
const tmux = { socketPath: '/tmp/tmux-1000/default', sessionId: '$1', windowId: '@1', paneId: '%1' } as const;
const generation = { pid: 42, startedAtMs: 100 } as const;
const reference = { kind: 'pane', hostId: HOST, localId: 'pane-1', lane: 'external', tmux, process: generation } as const;

/** Verifiers backed by an injected roster: the real gates run, only discovery is replaced. */
function verifiersFor(tmuxName: string) {
  const external = { kind: 'codex', tmux, tmuxName, agentPid: generation.pid, startedAtMs: generation.startedAtMs, connectionIssue: null, providerSessionId: null } as never;
  const live = { id: 'live-1', tmux, tmuxName, claim: 'lineage', process: generation, connectionIssue: null } as never;
  return {
    external: (tmuxValue: unknown, processValue: unknown) => assertFreshExternalTmuxTarget(tmuxValue, processValue, { scan: async () => [external], assertPaneIdentity: async () => {} }),
    live: (tmuxValue: unknown, processValue: unknown) => assertLineageTmuxTarget(tmuxValue as typeof tmux, processValue as typeof generation, async () => [live], async () => {}),
  };
}

test('fleet terminal attach refuses a protected company* pane like local attach and fleet mutations do', async () => {
  const protectedPane = verifiersFor('company-ops');
  await assert.rejects(verifyLocalRemoteTerminalTarget(reference, protectedPane), (error: unknown) => error instanceof RemoteTerminalPeerError && error.code === 'FLEET_UNAUTHORIZED');
  await assert.rejects(verifyLocalRemoteTerminalTarget({ ...reference, lane: 'live' }, protectedPane), (error: unknown) => error instanceof RemoteTerminalPeerError && error.code === 'FLEET_UNAUTHORIZED');

  const plain = verifiersFor('agent-1');
  assert.deepEqual(await verifyLocalRemoteTerminalTarget(reference, plain), reference);
  assert.deepEqual(await verifyLocalRemoteTerminalTarget({ ...reference, lane: 'live' }, plain), { ...reference, lane: 'live' });
});
