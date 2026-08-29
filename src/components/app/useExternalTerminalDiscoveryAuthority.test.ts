import assert from 'node:assert/strict';
import test from 'node:test';

import type { ExternalTerminalTarget } from '../../types/app';

import { isRemoteExternalTarget } from './useExternalTerminalDiscoveryAuthority';

function target(hostId?: string): ExternalTerminalTarget {
  return {
    ...(hostId === undefined ? {} : { hostId }),
    tmuxName: 'fleet-collision',
    tmux: { socketPath: '/owned/test.sock', sessionId: '$1', windowId: '@1', paneId: '%1' },
    process: { pid: 41, startedAtMs: 1 },
    kind: 'Codex', cliKind: 'codex', project: null,
  };
}

test('remote external targets are excluded from hub-local discovery authority', () => {
  assert.equal(isRemoteExternalTarget(target('11111111-1111-4111-8111-111111111111')), true);
  assert.equal(isRemoteExternalTarget(target()), false);
  assert.equal(isRemoteExternalTarget(null), false);
});
