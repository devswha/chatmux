import assert from 'node:assert/strict';
import test from 'node:test';

import {
  completionExternalGenerationIdentityFromSession,
  completionExternalGenerationIdentityKey,
  completionExternalGenerationPaneEvidenceKey,
} from '@/modules/database/index.js';
import { createExternalTurnMonitor } from '@/modules/notifications/services/external-turn-monitor.service.js';

type Activity = 'running' | 'waiting_user' | 'asking_user' | 'unknown';
const session = (overrides: Record<string, unknown> = {}) => ({
  tmuxName: 'pane', kind: 'claude', providerSessionId: 'native', agentPid: 9, startedAtMs: 10,
  tmux: { socketPath: '/tmp/tmux', sessionId: '$1', windowId: '@1', paneId: '%1' }, ...overrides,
});
const resolved = (activity: Activity, terminalOutcome: 'reply_ready' | 'failed' | 'none' | 'unknown' = 'none', cursor = 'cursor') => ({
  status: 'resolved' as const, activity, terminalOutcome, evidenceCursor: cursor, evidenceDigest: `digest-${cursor}`,
  appSession: null, transcriptEnded: false,
});

function harness() {
  let sessions: any[] = [session(), session({ kind: 'cursor', agentPid: undefined })];
  let detailedOk = true;
  let answer: any = resolved('waiting_user', 'reply_ready');
  let throwObserve = false;
  let observedState: 'unobserved' | 'running' | 'terminal' = 'unobserved';
  let stateRevision = 0;
  let lastEvidenceCursor: string | null = null;
  const observed: any[] = []; const decisions: any[] = []; const wakes: number[] = []; const pruned: number[] = [];
  const touches: any[] = [];
  const operations: string[] = [];
  let staleCandidates: any[] = [];
  const terminalResults: number[][] = [];
  const generationTargets = () => {
    const targets = new Map<string, { id: number; identityKey: string }>();
    for (const item of sessions) {
      const identity = completionExternalGenerationIdentityFromSession(item);
      if (!identity) continue;
      const identityKey = completionExternalGenerationIdentityKey(identity);
      targets.set(identityKey, { id: item.generationTargetId ?? 17, identityKey });
    }
    return [...targets.values()];
  };
  const primary = () => sessions[0];
  const monitor = createExternalTurnMonitor({
    getDetailed: async () => ({ ok: detailedOk, sessions }), getUserId: () => 1,
    resolve: async () => answer,
    resolveTargets: ((detailed: any) => detailed.sessions.filter((item: any) => item.kind !== 'cursor').map((item: any) => ({
      generationIdentityKey: completionExternalGenerationIdentityKey(completionExternalGenerationIdentityFromSession(item)!),
      generationTargetId: item.generationTargetId ?? 17,
      appSessionId: null, target: { alias: 'target' }, mappingState: item.mappingState ?? 'inactive_match',
    }))) as any,
    observeGeneration: (_id, cursor, observation) => {
      if (throwObserve) throw new Error('db');
      observed.push({ cursor, observation });
      if (observation === 'unavailable' || cursor === lastEvidenceCursor) {
        return { state: observedState, sequence: null, replay: true, stateRevision };
      }
      lastEvidenceCursor = cursor;
      observedState = observation === 'running' ? 'running' : 'terminal';
      stateRevision += 1;
      return {
        state: observedState,
        sequence: observation === 'running' ? 1 : null,
        replay: false,
        stateRevision,
      };
    },
    createTerminalDecision: (input) => {
      decisions.push(input);
      if (observedState === 'terminal' && input.evidenceCursor === lastEvidenceCursor) {
        terminalResults.push([1]);
        return { status: 'replay' as const, decisionIds: [1] };
      }
      if (observedState !== 'running' || input.evidenceCursor === lastEvidenceCursor) {
        observedState = 'terminal';
        lastEvidenceCursor = input.evidenceCursor;
        return { status: 'baselined' as const, decisionIds: [] };
      }
      observedState = 'terminal';
      lastEvidenceCursor = input.evidenceCursor;
      terminalResults.push([1]);
      return { status: 'decided' as const, decisionIds: [1] };
    }, listGenerationTargets: generationTargets, wake: () => wakes.push(1),
    touchObservedGenerations: (observations, lastSeenAt) => {
      operations.push('touch');
      touches.push({ observations, lastSeenAt });
    },
    listStaleGenerationCandidates: () => staleCandidates,
    pruneStaleGenerationCandidates: (_cutoff, ids) => {
      operations.push('prune');
      pruned.push(...ids);
      return ids.length;
    },
    generationCount: () => 0,
    now: () => 30 * 24 * 60 * 60 * 1_000 + 1,
  });
  return {
    monitor, observed, decisions, terminalResults, wakes, pruned, touches, operations,
    setSessions: (value: any[]) => { sessions = value; },
    setDetailedOk: (value: boolean) => { detailedOk = value; },
    setStaleCandidates: (value: any[]) => { staleCandidates = value; },
    setAnswer: (value: any) => { answer = value; },
    setThrowObserve: (value: boolean) => { throwObserve = value; }, primary,
  };
}

test('external monitor silently persists a startup reply-ready baseline, then creates a durable decision after a running arm', async () => {
  const h = harness();
  await h.monitor.tick();
  assert.deepEqual(h.observed, []);
  assert.equal(h.decisions.length, 1, 'the durable repository receives baseline evidence');
  assert.equal(h.monitor.stats().baselined, 1);
  await h.monitor.tick();
  assert.equal(h.decisions.length, 2, 'the durable repository receives terminal replay evidence');
  assert.equal(h.monitor.stats().decision_unavailable, 0);
  h.setAnswer(resolved('running', 'none', 'run-1')); await h.monitor.tick();
  h.setAnswer(resolved('waiting_user', 'reply_ready', 'done-1')); await h.monitor.tick();
  assert.deepEqual(h.observed.at(-1), { cursor: 'run-1', observation: 'running' });
  assert.equal(h.decisions.length, 3);
  assert.deepEqual(h.terminalResults, [[1], [1]]);
  assert.equal(h.wakes.length, 1);
});

test('terminal replay is delegated to the durable decision repository after an armed generation', async () => {
  const h = harness();
  h.setAnswer(resolved('running', 'none', 'run')); await h.monitor.tick();
  h.setAnswer(resolved('waiting_user', 'reply_ready', 'same')); await h.monitor.tick(); await h.monitor.tick();
  assert.equal(h.decisions.length, 2);
  assert.deepEqual(h.terminalResults, [[1], [1]], 'the repository returns the same durable decision on terminal replay');
});
test('unavailable evidence never touches durable state', async () => {
  const h = harness();
  h.setAnswer({ status: 'unavailable', activity: 'unknown', reasonCode: 'transcript_read_unavailable', appSession: null, transcriptEnded: false });
  await h.monitor.tick();
  assert.equal(h.observed.length + h.decisions.length, 0);
});

test('running arms, transcript end suppresses, and failed asking or unknown evidence disarm through observations', async () => {
  const h = harness();
  h.setAnswer(resolved('running', 'none', 'r')); await h.monitor.tick();
  h.setAnswer({ ...resolved('waiting_user', 'reply_ready', 'ended'), transcriptEnded: true }); await h.monitor.tick();
  for (const [activity, outcome] of [['waiting_user', 'failed'], ['asking_user', 'none'], ['unknown', 'unknown']] as const) {
    h.setAnswer(resolved(activity, outcome, `${activity}-${outcome}`)); await h.monitor.tick();
  }
  assert.deepEqual(h.observed.map(({ observation }) => observation), ['running', 'unknown', 'failed', 'asking', 'unknown']);
  assert.equal(h.decisions.length, 0);
});

test('database observation errors preserve the next terminal decision attempt', async () => {
  const h = harness();
  h.setThrowObserve(true); h.setAnswer(resolved('running', 'none', 'run')); await h.monitor.tick();
  h.setThrowObserve(false); h.setAnswer(resolved('waiting_user', 'reply_ready', 'done')); await h.monitor.tick();
  assert.equal(h.decisions.length, 1);
});

test('Cursor is omitted while supported external OMP generations are included', async () => {
  const h = harness();
  h.setSessions([session({ kind: 'cursor' }), session({ kind: 'omp', paneId: '%2', providerSessionId: undefined }), session({ kind: 'cursor', agentPid: undefined })]);
  await h.monitor.tick();
  assert.equal(h.decisions.length, 1);
  assert.equal(h.observed.length, 0);
});

test('complete scans touch exact durable generations even when they have no notification resolution', async () => {
  const external = session({ generationTargetId: 41 }) as any;
  const identityKey = completionExternalGenerationIdentityKey(completionExternalGenerationIdentityFromSession(external)!);
  const touches: any[] = [];
  const monitor = createExternalTurnMonitor({
    getUserId: () => 1,
    getDetailed: async () => ({ ok: true, sessions: [external] }),
    resolve: async () => resolved('waiting_user', 'reply_ready'),
    resolveTargets: () => [],
    listGenerationTargets: () => [{ id: 41, identityKey }],
    touchObservedGenerations: (observations) => touches.push(observations),
    listStaleGenerationCandidates: () => [],
    pruneStaleGenerationCandidates: () => 0,
    generationCount: () => 0,
  });
  await monitor.tick();
  assert.deepEqual(touches, [[{
    generationTargetId: 41,
    paneEvidenceKey: completionExternalGenerationPaneEvidenceKey(external.tmux),
  }]]);
});

test('incomplete scans preserve durable generations while complete scans touch before pruning absent targets', async () => {
  const h = harness();
  const paneEvidenceKey = completionExternalGenerationPaneEvidenceKey(h.primary().tmux);
  h.setStaleCandidates([{ generationTargetId: 17, paneEvidenceKey, lastSeenAt: 0 }]);
  h.setSessions([session({ agentPid: undefined })]); await h.monitor.tick();
  assert.equal(h.touches.length, 0, 'an incomplete scan cannot authoritatively touch or prune');
  assert.equal(h.pruned.length, 0, 'an incomplete scan cannot prove absence');
  h.setSessions([]); await h.monitor.tick();
  assert.deepEqual(h.pruned, [17]);
  assert.deepEqual(h.touches, [{ observations: [], lastSeenAt: 30 * 24 * 60 * 60 * 1_000 + 1 }]);
});
test('unavailable discovery neither touches nor prunes generations', async () => {
  const h = harness();
  const paneEvidenceKey = completionExternalGenerationPaneEvidenceKey(h.primary().tmux);
  h.setStaleCandidates([{ generationTargetId: 17, paneEvidenceKey, lastSeenAt: 0 }]);
  h.setDetailedOk(false); await h.monitor.tick();
  assert.equal(h.touches.length, 0);
  assert.equal(h.pruned.length, 0);
  assert.equal(h.monitor.stats().discovery_unavailable, 1);
});
test('complete scans retain an old generation when its pane has no complete replacement', async () => {
  const h = harness();
  const paneEvidenceKey = completionExternalGenerationPaneEvidenceKey(h.primary().tmux);
  h.setStaleCandidates([{ generationTargetId: 99, paneEvidenceKey, lastSeenAt: 0 }]);
  h.setSessions([session({ agentPid: undefined })]); await h.monitor.tick();
  assert.equal(h.pruned.length, 0);
  h.setSessions([session({ generationTargetId: 99 })]); await h.monitor.tick();
  assert.equal(h.pruned.length, 0, 'the same complete generation is retained');
});

test('complete scans prune an old generation only after touching an authoritative same-pane replacement', async () => {
  const h = harness();
  const paneEvidenceKey = completionExternalGenerationPaneEvidenceKey(h.primary().tmux);
  h.setStaleCandidates([{ generationTargetId: 17, paneEvidenceKey, lastSeenAt: 0 }]);
  h.setSessions([session({ generationTargetId: 18 })]); await h.monitor.tick();
  assert.deepEqual(h.touches[0].observations, [{ generationTargetId: 18, paneEvidenceKey }]);
  assert.deepEqual(h.pruned, [17]);
  assert.deepEqual(h.operations.slice(-2), ['touch', 'prune']);
});

test('same-pane active and ambiguous complete replacements can prune stale generations', async () => {
  const h = harness();
  const paneEvidenceKey = completionExternalGenerationPaneEvidenceKey(h.primary().tmux);
  h.setStaleCandidates([{ generationTargetId: 17, paneEvidenceKey, lastSeenAt: 0 }]);
  h.setSessions([session({ generationTargetId: 18, mappingState: 'one_active' })]); await h.monitor.tick();
  assert.deepEqual(h.pruned, [17]);
  h.pruned.length = 0;
  h.setSessions([session({ generationTargetId: 18, mappingState: 'ambiguous_active' })]); await h.monitor.tick();
  assert.deepEqual(h.pruned, [17]);
});
test('read backoff resets when a provider binding changes', async () => {
  let now = 0; let calls = 0; const first = session({ providerSessionId: undefined }); const key = completionExternalGenerationIdentityKey(completionExternalGenerationIdentityFromSession(first as any)!);
  let current: any = first;
  const monitor = createExternalTurnMonitor({ getUserId: () => 1, now: () => now, getDetailed: async () => ({ ok: true, sessions: [current, session({ kind: 'cursor', agentPid: undefined })] }), resolve: async () => { calls += 1; return { status: 'unavailable', activity: 'unknown', reasonCode: 'transcript_read_unavailable', appSession: null, transcriptEnded: false }; }, resolveTargets: (() => [{ generationIdentityKey: key, generationTargetId: 1, appSessionId: null, target: { alias: 'x' } }]) as any, observeGeneration: () => ({ state: 'unobserved' as const, replay: false, sequence: null, stateRevision: 0 }), createTerminalDecision: () => ({ status: 'replay' as const, decisionIds: [] }), listGenerationTargets: () => [], touchObservedGenerations: () => {}, listStaleGenerationCandidates: () => [], pruneStaleGenerationCandidates: () => 0, generationCount: () => 0 });
  await monitor.tick(); now = 5_000; await monitor.tick(); now = 5_001; await monitor.tick();
  assert.equal(calls, 2, 'second failure schedules backoff');
  current = session({ providerSessionId: 'late' }); await monitor.tick();
  assert.equal(calls, 3, 'binding change clears the pending backoff');
});
