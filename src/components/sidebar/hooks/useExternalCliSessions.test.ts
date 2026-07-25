import assert from 'node:assert/strict';
import test from 'node:test';

import { tmuxPaneIdentityKey } from '../../../../shared/tmux';
import type { DiscoveryRow } from '../../../hooks/useDiscoveryStream';

import { mergeExternalDiscoveryRows, type ExternalCliSession } from './useExternalCliSessions';

const tmux = { socketPath: 'socket', sessionId: '$1', windowId: '@1', paneId: '%1' };
const process = { pid: 42, startedAtMs: 100 };

test('hydrates external metadata onto a discovery row that arrived first', () => {
  const row: DiscoveryRow = {
    key: 'external:1', lane: 'external', tmuxName: 'stream-name', tmux, process,
    kind: 'claude', providerSessionId: null, activity: 'waiting_user', cwd: '/stream', presence: 'present',
  };
  const restSession: ExternalCliSession = {
    tmuxName: 'rest-name', tmux, process, kind: 'claude', transcriptSessionId: 'transcript-1',
    sessionName: 'REST session', model: 'sonnet', effort: 'high', attachCapability: 'capability',
  };

  const sessions = mergeExternalDiscoveryRows([row], new Map([[tmuxPaneIdentityKey(tmux), restSession]]), []);

  assert.deepEqual(sessions, [{
    ...restSession,
    tmuxName: 'stream-name',
    process,
    activity: 'waiting_user',
    projectPath: '/stream',
  }]);
});
