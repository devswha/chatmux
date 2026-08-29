import assert from 'node:assert/strict';
import test from 'node:test';

import { tmuxPaneIdentityKey } from '../../../../shared/tmux';
import type { DiscoveryRow } from '../../../hooks/useDiscoveryStream';
import { readRestSessionContainer } from '../../../utils/liveSessions';

import {
  clearExternalSessionActivities,
  externalIdentityOnly,
  mergeExternalDiscoveryRows,
  shouldApplyExternalRestResponse,
  type ExternalCliSession,
} from './useExternalCliSessions';

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
    presence: 'present',
    authority: 'stream',
  }]);
});

test('rebinds a restarted process in the same pane to its new provider session', () => {
  const restartedProcess = { pid: 84, startedAtMs: 200 };
  const row: DiscoveryRow = {
    key: 'external:1', lane: 'external', tmuxName: 'stream-name', tmux,
    process: restartedProcess, kind: 'omo', providerSessionId: 'transcript-2',
    activity: 'waiting_user', cwd: '/new-project', presence: 'present',
  };
  const staleSession: ExternalCliSession = {
    tmuxName: 'rest-name', tmux, process, kind: 'omo', transcriptSessionId: 'transcript-1',
    sessionName: 'Previous session', model: 'old-model', effort: 'high',
    transcriptEnded: true, projectPath: '/old-project',
  };

  const sessions = mergeExternalDiscoveryRows(
    [row],
    new Map([[tmuxPaneIdentityKey(tmux), staleSession]]),
    [staleSession],
  );

  assert.deepEqual(sessions, [{
    tmuxName: 'stream-name',
    tmux,
    process: restartedProcess,
    kind: 'omo',
    activity: 'waiting_user',
    projectPath: '/new-project',
    transcriptSessionId: 'transcript-2',
    presence: 'present',
    authority: 'stream',
  }]);
});

test('rebinds a new provider session even when the process generation is unchanged', () => {
  const row: DiscoveryRow = {
    key: 'external:1', lane: 'external', tmuxName: 'stream-name', tmux, process,
    kind: 'claude', providerSessionId: 'transcript-2', activity: 'waiting_user',
    cwd: '/stream', presence: 'present',
  };
  const staleSession: ExternalCliSession = {
    tmuxName: 'rest-name', tmux, process, kind: 'claude', transcriptSessionId: 'transcript-1',
    sessionName: 'Previous session', model: 'old-model', effort: 'high',
  };

  const [session] = mergeExternalDiscoveryRows([row], new Map(), [staleSession]);

  assert.equal(session.transcriptSessionId, 'transcript-2');
  assert.equal(session.sessionName, undefined);
  assert.equal(session.model, undefined);
  assert.equal(session.effort, undefined);
});

test('stream loss clears mutable provider activity before REST fallback', () => {
  const sessions: ExternalCliSession[] = [
    { tmuxName: 'error', tmux, process, kind: 'claude', activity: 'error' },
    { tmuxName: 'running', tmux: { ...tmux, paneId: '%2' }, process, kind: 'codex', activity: 'running' },
    { tmuxName: 'unknown', tmux: { ...tmux, paneId: '%3' }, process, kind: 'shell', activity: 'unknown' },
  ];

  const cleared = clearExternalSessionActivities(sessions);
  assert.deepEqual(cleared.map((session) => session.activity), ['unknown', 'unknown', 'unknown']);
  assert.equal(cleared[2], sessions[2], 'already-unknown metadata is preserved without copying');
});

test('stream discovery propagates a deterministic connection exclusion reason', () => {
  const row: DiscoveryRow = {
    key: 'external:issue', lane: 'external', tmuxName: 'foreign-agent', tmux, process,
    kind: 'codex', providerSessionId: null, activity: 'unknown', cwd: '/stream',
    presence: 'present', connectionIssue: 'agent_home_mismatch',
  };
  const [session] = mergeExternalDiscoveryRows([row], new Map(), []);
  assert.equal(session.connectionIssue, 'agent_home_mismatch');
  assert.equal(session.authority, 'stream');
});

test('REST request generations reject a late bootstrap response', () => {
  assert.equal(shouldApplyExternalRestResponse(2, 1, false), true);
  assert.equal(
    shouldApplyExternalRestResponse(1, 2, false),
    false,
    'an older bootstrap response cannot overwrite a newer fallback response',
  );
  assert.equal(shouldApplyExternalRestResponse(3, 2, true), false);
});
test('newest generation wins across recovery and unmount fencing', () => {
  assert.equal(shouldApplyExternalRestResponse(2, 1, false, 2), true);
  assert.equal(shouldApplyExternalRestResponse(1, 0, false, 2), false);
  assert.equal(shouldApplyExternalRestResponse(2, 1, false, 3), false);
  assert.equal(shouldApplyExternalRestResponse(3, 2, true, 3), false);
});
test('a malformed newest external container fences an older successful response', () => {
  let appliedGeneration = 0;
  const latestGeneration = 2;
  assert.equal(
    shouldApplyExternalRestResponse(2, appliedGeneration, false, latestGeneration),
    true,
  );
  assert.equal(
    readRestSessionContainer({ data: { externalSessions: {} } }, 'externalSessions'),
    null,
  );
  appliedGeneration = 2;
  assert.equal(
    shouldApplyExternalRestResponse(1, appliedGeneration, false, latestGeneration),
    false,
  );
});

test('false discovery sanitizes reported-present external rows to identity only', () => {
  const sanitized = externalIdentityOnly({
    tmuxName: 'still-visible',
    tmux,
    process,
    kind: 'claude',
    activity: 'running',
    transcriptSessionId: 'transcript',
    sessionName: 'Sensitive session',
    model: 'opus',
    effort: 'high',
    transcriptEnded: true,
    attachCapability: 'attach-token',
    projectPath: '/workspace/project',
  });

  assert.deepEqual(sanitized, {
    tmuxName: 'still-visible',
    tmux,
    process: null,
    kind: 'claude',
    activity: 'unknown',
    presence: 'stale',
    authority: 'none',
  });
});
