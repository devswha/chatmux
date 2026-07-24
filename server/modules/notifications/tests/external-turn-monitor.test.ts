import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createExternalTurnMonitor,
  type ExternalTurnMonitorDiagnostic,
} from '@/modules/notifications/services/external-turn-monitor.service.js';
import type { ExternalSessionActivityResolutionResult } from '@/modules/providers/index.js';

type Activity = 'running' | 'waiting_user' | 'asking_user' | 'unknown';
type Resolution =
  | { status: 'resolved'; activity: Activity; appSession?: { session_id: string }; transcriptEnded?: boolean }
  | { status: 'unavailable' };

type ExternalSession = {
  tmuxName: string;
  tmux: { socketPath: string; sessionId: string; windowId: string; paneId: string };
  kind: 'claude' | 'codex' | 'cursor' | 'opencode' | 'omp' | 'ssh' | 'shell';
  providerSessionId?: string;
  agentPid?: number;
  startedAtMs?: number;
};

type Notification = {
  provider: string;
  sessionId: string | null;
  tmuxName: string;
  completionKey: string;
};

function session(overrides: Partial<ExternalSession> = {}): ExternalSession {
  return {
    tmuxName: 'external-pane',
    tmux: { socketPath: '/tmp/tmux-1000/default', sessionId: '$1', windowId: '@2', paneId: '%3' },
    kind: 'claude',
    providerSessionId: 'native-1',
    agentPid: 321,
    startedAtMs: 1_700_000_000_000,
    ...overrides,
  };
}

function makeHarness() {
  let discovery: { ok: boolean; sessions: ExternalSession[] } = { ok: true, sessions: [] };
  let resolution: Resolution = { status: 'unavailable' };
  const resolvedSessions: ExternalSession[] = [];
  const notifications: Notification[] = [];
  const diagnostics: ExternalTurnMonitorDiagnostic[] = [];
  const monitor = createExternalTurnMonitor({
    getDetailed: async () => discovery,
    resolve: async (externalSession) => {
      resolvedSessions.push(externalSession);
      return resolution as ExternalSessionActivityResolutionResult;
    },
    notify: (event) => notifications.push(event),
    getUserId: () => 1,
    diagnostic: (event) => diagnostics.push(event),
  });

  return {
    monitor,
    notifications,
    diagnostics,
    resolvedSessions,
    setDiscovery(next: typeof discovery) {
      discovery = next;
    },
    setResolution(next: Resolution) {
      resolution = next;
    },
  };
}

test('external monitor emits once per armed running-to-waiting transition without startup replay', async () => {
  const h = makeHarness();
  const external = session();
  h.setDiscovery({ ok: true, sessions: [external] });

  h.setResolution({ status: 'resolved', activity: 'waiting_user', appSession: { session_id: 'app-1' } });
  await h.monitor.tick();
  assert.equal(h.notifications.length, 0, 'first sight waiting must be a silent baseline');

  h.setResolution({ status: 'resolved', activity: 'running', appSession: { session_id: 'app-1' } });
  await h.monitor.tick();
  h.setResolution({ status: 'resolved', activity: 'waiting_user', appSession: { session_id: 'app-1' } });
  await h.monitor.tick();
  await h.monitor.tick();

  assert.equal(h.notifications.length, 1, 'repeated waiting must not duplicate a completion');
  assert.equal(h.notifications[0].provider, 'claude');
  assert.equal(h.notifications[0].sessionId, 'app-1');
  assert.match(h.notifications[0].completionKey, /^[a-f0-9]{64}:1$/);
  assert.doesNotMatch(h.notifications[0].completionKey, /external-pane|native-1|321/);

  h.setResolution({ status: 'resolved', activity: 'running', appSession: { session_id: 'app-1' } });
  await h.monitor.tick();
  h.setResolution({ status: 'resolved', activity: 'waiting_user', appSession: { session_id: 'app-1' } });
  await h.monitor.tick();

  assert.equal(h.notifications.length, 2);
  assert.match(h.notifications[1].completionKey, /^[a-f0-9]{64}:2$/);
});

test('late provider-session binding rebaselines once, persists through omissions, and fails closed on conflict', async () => {
  const h = makeHarness();
  const unbound = session({ providerSessionId: undefined });
  h.setDiscovery({ ok: true, sessions: [unbound] });
  await h.monitor.tick();
  assert.equal(h.resolvedSessions.length, 1);

  h.setDiscovery({ ok: true, sessions: [session({ providerSessionId: 'native-1' })] });
  h.setResolution({ status: 'resolved', activity: 'waiting_user' });
  await h.monitor.tick();
  assert.equal(h.notifications.length, 0, 'first native-id binding must not replay a waiting turn');

  h.setDiscovery({ ok: true, sessions: [unbound] });
  h.setResolution({ status: 'resolved', activity: 'running' });
  await h.monitor.tick();
  assert.equal(h.resolvedSessions.at(-1)?.providerSessionId, 'native-1', 'missing snapshots retain the first binding');
  h.setResolution({ status: 'resolved', activity: 'waiting_user' });
  await h.monitor.tick();
  assert.equal(h.notifications.length, 1);

  const callsBeforeConflict = h.resolvedSessions.length;
  h.setDiscovery({ ok: true, sessions: [session({ providerSessionId: 'native-conflict' })] });
  await h.monitor.tick();
  assert.equal(h.resolvedSessions.length, callsBeforeConflict, 'conflicting native ids must not be resolved');
  assert.equal(h.notifications.length, 1);
});

test('unavailable evidence preserves arms; asking, unknown, and ended transcripts disarm; successful absence prunes', async () => {
  const h = makeHarness();
  const external = session({ kind: 'codex' });
  h.setDiscovery({ ok: true, sessions: [external] });

  h.setResolution({ status: 'resolved', activity: 'running' });
  await h.monitor.tick();
  h.setResolution({ status: 'unavailable' });
  await h.monitor.tick();
  h.setResolution({ status: 'resolved', activity: 'waiting_user' });
  await h.monitor.tick();
  assert.equal(h.notifications.length, 1, 'unavailable resolution must preserve a previously armed turn');

  for (const disarmingResolution of [
    { status: 'resolved', activity: 'asking_user' },
    { status: 'resolved', activity: 'unknown' },
    { status: 'resolved', activity: 'waiting_user', transcriptEnded: true },
  ] as const) {
    h.setResolution({ status: 'resolved', activity: 'running' });
    await h.monitor.tick();
    h.setResolution(disarmingResolution);
    await h.monitor.tick();
    h.setResolution({ status: 'resolved', activity: 'waiting_user' });
    await h.monitor.tick();
  }
  assert.equal(h.notifications.length, 1, 'non-completion activity must disarm before a later wait');

  h.setDiscovery({ ok: false, sessions: [] });
  await h.monitor.tick();
  assert.equal(h.monitor.generationCount(), 1, 'unavailable discovery must preserve tracked generations');
  h.setDiscovery({ ok: true, sessions: [] });
  await h.monitor.tick();
  assert.equal(h.monitor.generationCount(), 0, 'successful discovery proves a generation disappeared');

  h.setDiscovery({ ok: true, sessions: [external] });
  h.setResolution({ status: 'resolved', activity: 'waiting_user' });
  await h.monitor.tick();
  h.setResolution({ status: 'resolved', activity: 'running' });
  await h.monitor.tick();
  h.setResolution({ status: 'resolved', activity: 'waiting_user' });
  await h.monitor.tick();
  assert.equal(h.notifications.length, 2, 'a rediscovered generation must baseline before future completion');
});

test('external monitor diagnostics are safe, monotonic, and cover state transitions', async () => {
  const h = makeHarness();
  const unbound = session({ providerSessionId: undefined });

  h.setDiscovery({ ok: true, sessions: [unbound] });
  h.setResolution({ status: 'resolved', activity: 'running' });
  await h.monitor.tick();

  h.setDiscovery({ ok: true, sessions: [session({ providerSessionId: 'native-1' })] });
  h.setResolution({ status: 'resolved', activity: 'waiting_user' });
  await h.monitor.tick();

  h.setDiscovery({ ok: true, sessions: [unbound] });
  h.setResolution({ status: 'resolved', activity: 'running' });
  await h.monitor.tick();
  h.setResolution({ status: 'resolved', activity: 'asking_user' });
  await h.monitor.tick();
  h.setResolution({ status: 'resolved', activity: 'running' });
  await h.monitor.tick();
  h.setResolution({ status: 'resolved', activity: 'unknown' });
  await h.monitor.tick();
  h.setResolution({ status: 'resolved', activity: 'running' });
  await h.monitor.tick();
  h.setResolution({ status: 'resolved', activity: 'waiting_user' });
  await h.monitor.tick();

  h.setResolution({ status: 'unavailable' });
  await h.monitor.tick();
  h.setDiscovery({ ok: false, sessions: [] });
  await h.monitor.tick();
  h.setDiscovery({ ok: true, sessions: [session({ providerSessionId: 'native-conflict' })] });
  await h.monitor.tick();

  h.setDiscovery({ ok: true, sessions: [session({ agentPid: 654, providerSessionId: 'native-1' })] });
  h.setResolution({ status: 'resolved', activity: 'waiting_user' });
  await h.monitor.tick();
  h.setDiscovery({ ok: true, sessions: [] });
  await h.monitor.tick();

  assert.deepEqual(
    h.diagnostics.map(({ code }) => code),
    [
      'baselined',
      'armed',
      'late_id_rebaselined',
      'armed',
      'disarmed_asking',
      'armed',
      'disarmed_unknown',
      'armed',
      'notified',
      'read_unavailable',
      'discovery_unavailable',
      'provider_id_conflict',
      'generation_reset',
      'baselined',
      'pruned',
    ],
  );
  assert.deepEqual(h.monitor.stats(), {
    baselined: 2,
    late_id_rebaselined: 1,
    armed: 4,
    notified: 1,
    disarmed_unknown: 1,
    disarmed_asking: 1,
    pruned: 1,
    discovery_unavailable: 1,
    read_unavailable: 1,
    provider_id_conflict: 1,
    generation_reset: 1,
  });
  assert.equal(h.notifications.length, 1);
  const emittedCounts = new Map<string, number>();
  for (const diagnostic of h.diagnostics) {
    const expectedCount = (emittedCounts.get(diagnostic.code) ?? 0) + 1;
    emittedCounts.set(diagnostic.code, expectedCount);
    assert.equal(diagnostic.count, expectedCount);
    assert.ok(
      Object.keys(diagnostic).every((key) => ['code', 'provider', 'tmuxName', 'count'].includes(key)),
    );
  }
  assert.doesNotMatch(
    JSON.stringify(h.diagnostics),
    /native-1|native-conflict|\/tmp\/tmux-1000\/default|\$1|@2|%3|321|1700000000000/u,
  );
});
test('external monitor excludes unsupported and incomplete process generations', async () => {
  const h = makeHarness();
  h.setDiscovery({
    ok: true,
    sessions: [
      session({ kind: 'ssh' }),
      session({ kind: 'shell' }),
      session({ kind: 'cursor', agentPid: undefined }),
      session({ kind: 'opencode', startedAtMs: undefined }),
      session({ kind: 'omp', tmux: { socketPath: '', sessionId: '$1', windowId: '@2', paneId: '%3' } }),
    ],
  });
  h.setResolution({ status: 'resolved', activity: 'running' });
  await h.monitor.tick();
  h.setResolution({ status: 'resolved', activity: 'waiting_user' });
  await h.monitor.tick();

  assert.equal(h.resolvedSessions.length, 0);
  assert.equal(h.notifications.length, 0);
  assert.equal(h.monitor.generationCount(), 0);
});

test('incomplete process metadata preserves an existing pane generation', async () => {
  const h = makeHarness();
  h.setDiscovery({ ok: true, sessions: [session()] });
  h.setResolution({ status: 'resolved', activity: 'running' });
  await h.monitor.tick();

  h.setDiscovery({ ok: true, sessions: [session({ agentPid: undefined })] });
  h.setResolution({ status: 'resolved', activity: 'waiting_user' });
  await h.monitor.tick();
  assert.equal(h.monitor.generationCount(), 1);
  assert.equal(h.notifications.length, 0);

  h.setDiscovery({ ok: true, sessions: [session()] });
  await h.monitor.tick();
  assert.equal(h.notifications.length, 1, 'terminal evidence after metadata recovery completes the armed turn');
});

test('external monitor never overlaps slow discovery ticks', async () => {
  let discoveryCalls = 0;
  let releaseDiscovery: (() => void) | undefined;
  const pendingDiscovery = new Promise<{ ok: boolean; sessions: ExternalSession[] }>((resolve) => {
    releaseDiscovery = () => resolve({ ok: true, sessions: [] });
  });
  const monitor = createExternalTurnMonitor({
    getDetailed: async () => {
      discoveryCalls += 1;
      return pendingDiscovery;
    },
    resolve: async () => ({ status: 'unavailable' } as ExternalSessionActivityResolutionResult),
    notify: () => undefined,
    getUserId: () => 1,
  });

  const firstTick = monitor.tick();
  await Promise.resolve();
  await monitor.tick();
  assert.equal(discoveryCalls, 1);
  releaseDiscovery?.();
  await firstTick;
});
