import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  completionExternalGenerationIdentityFromSession,
  completionExternalGenerationIdentityKey,
} from '@/modules/database/index.js';
import { createExternalTurnMonitor } from '@/modules/notifications/index.js';
import {
  createDiscoveryCollector,
  type DiscoveryRow,
} from '@/modules/providers/services/discovery-collector.service.js';
import {
  createExternalCliSessionDiscovery,
  type ExternalCliSessionCommandRunner,
} from '@/modules/providers/services/external-cli-sessions.service.js';
import {
  resetHostCommandCounters,
  snapshotHostCommandCounters,
  type HostCommandCounters,
} from '@/modules/providers/services/host-command-metrics.service.js';
import {
  createLiveGjcSessionDiscovery,
  type LiveGjcSessionCommandRunner,
} from '@/modules/providers/services/live-sessions.service.js';
import { createDiscoveryStream } from '@/modules/websocket/index.js';

const T_MS = 20_000;
const C_SCAN_MS = 1_000;
const K_TOTAL_PER_S = 38;
const K_KEY_PER_S = {
  'tmux list-panes': 4,
  'tmux display-message': 2,
  'tmux capture-pane': 2,
  'ps -eo': 4,
  'ps -p': 8,
  lsof: 2,
  'read /proc': 8,
  'read runtime-receipt': 4,
  'read transcript': 4,
} as const;

class FakeWebSocket {
  readonly readyState = 1;
  readonly bufferedAmount = 0;
  readonly sent: string[] = [];

  send(frame: string): void { this.sent.push(frame); }
  close(): void {}
}

type Client = { ws: FakeWebSocket; rows: Map<string, DiscoveryRow> };

const EXTERNAL_TMUX = '/tmp/test\t$1\t@1\t%1\texternal-ssh\t101\tssh\t\t/work\t\t\n';
const LIVE_TMUX = '/tmp/test\t$1\t@1\t%2\tlive-empty\t102\tbash\t/work\n';
const EXTERNAL_PS = 'PID PPID COMMAND COMMAND\n101 1 ssh ssh host\n';
const LIVE_PS = 'PID PPID COMMAND\n102 1 bash bash\n';

function createExternalRunner(): ExternalCliSessionCommandRunner {
  return async (command, args) => {
    if (command === 'tmux' && args[0] === 'list-panes') return EXTERNAL_TMUX;
    if (command === 'ps' && args[0] === '-eo') return EXTERNAL_PS;
    throw new Error(`unexpected external command: ${command} ${args.join(' ')}`);
  };
}

function createLiveRunner(): LiveGjcSessionCommandRunner {
  return async (command, args) => {
    if (command === 'tmux' && args[0] === 'list-panes') return LIVE_TMUX;
    if (command === 'lsof') return '';
    if (command === 'ps' && args[0] === '-eo') return LIVE_PS;
    throw new Error(`unexpected live command: ${command} ${args.join(' ')}`);
  };
}

function applyFrames(client: Client): void {
  for (const frame of client.ws.sent.splice(0)) {
    const event = JSON.parse(frame) as { kind?: string; rows?: DiscoveryRow[]; changes?: Array<Record<string, unknown>> };
    if (event.kind === 'discovery.snapshot') {
      client.rows = new Map((event.rows ?? []).map((row) => [row.key, row]));
      continue;
    }
    if (event.kind !== 'discovery.delta') continue;
    for (const change of event.changes ?? []) {
      if (change.op === 'added') {
        const row = change.row as DiscoveryRow;
        client.rows.set(row.key, row);
      } else if (change.op === 'updated' && typeof change.key === 'string') {
        const row = client.rows.get(change.key);
        if (row) client.rows.set(change.key, { ...row, ...(change.patch as Partial<DiscoveryRow>) });
      } else if (change.op === 'stale' && typeof change.key === 'string') {
        const row = client.rows.get(change.key);
        if (row) client.rows.set(change.key, { ...row, presence: 'stale' });
      } else if (change.op === 'removed' && typeof change.key === 'string') client.rows.delete(change.key);
    }
  }
}

function assertCostBounds(counters: HostCommandCounters, subscribers: number): void {
  const seconds = T_MS / 1_000;
  for (const [key, limit] of Object.entries(K_KEY_PER_S)) {
    const actual = counters[key] ?? 0;
    assert.ok(actual / seconds <= limit, `assert A: ${key} ${actual} exceeded ${limit}/s (N=${subscribers}, cadence=${C_SCAN_MS})`);
  }
  assert.ok((counters['tmux list-panes'] ?? 0) <= (T_MS / C_SCAN_MS) * 2 + 10,
    `assert A: collector list-panes exceeded shared-scanner cadence bound (N=${subscribers})`);
  assert.ok((counters['tmux capture-pane'] ?? 0) <= (T_MS / C_SCAN_MS) + 2,
    `assert C: capture-pane exceeded one active pane bound (N=${subscribers})`);
  const total = Object.values(counters).reduce((sum, value) => sum + value, 0) / seconds;
  assert.ok(total <= K_TOTAL_PER_S, `assert D: host invocations/sec ${total} exceeded ${K_TOTAL_PER_S} (N=${subscribers})`);
}

async function runScenario(subscribers: number, subscriberPolling = false): Promise<{
  counters: HostCommandCounters;
  clients: Client[];
  expected: readonly DiscoveryRow[];
  monitorScannerCalls: number;
  monitorAdapterCalls: number;
  monitorTicks: number;
}> {
  let now = 0;
  let monitorScannerCalls = 0;
  let monitorAdapterCalls = 0;
  let monitorTicks = 0;
  const external = createExternalCliSessionDiscovery({
    now: () => now,
    cacheTtlMs: 0,
    commandRunner: createExternalRunner(),
  });
  const live = createLiveGjcSessionDiscovery({ commandRunner: createLiveRunner() });
  const collector = createDiscoveryCollector({
    now: () => now,
    scanExternal: () => external.getExternalCliSessionsDetailed(),
    scanLive: () => live.getLiveGjcSessionsDetailed(),
  });
  const stream = createDiscoveryStream(collector, () => now);
  const clients = Array.from({ length: subscribers }, () => ({ ws: new FakeWebSocket(), rows: new Map<string, DiscoveryRow>() }));
  for (const client of clients) stream.handle(client.ws as never, { type: 'discovery.subscribe', protocolVersion: 1 });
  const monitor = createExternalTurnMonitor({
    getDetailed: async () => {
      monitorScannerCalls += 1;
      await external.getExternalCliSessionsDetailed();
      return {
        ok: true,
        sessions: [{
          tmuxName: 'external-monitor',
          tmux: { socketPath: '/tmp/test', sessionId: '$1', windowId: '@1', paneId: '%1' },
          kind: 'claude',
          agentPid: 101,
          startedAtMs: 1,
        }],
      };
    },
    resolve: async () => {
      monitorAdapterCalls += 1;
      return {
        status: 'resolved' as const,
        activity: 'running' as const,
        terminalOutcome: 'none' as const,
        evidenceCursor: `running-${monitorAdapterCalls}`,
        evidenceDigest: `digest-${monitorAdapterCalls}`,
        appSession: null,
        transcriptEnded: false,
      };
    },
    notify: () => undefined,
    getUserId: () => 1,
    resolveTargets: ((detailed: { sessions: Array<Record<string, unknown>> }) => detailed.sessions.map((session) => {
      const identity = completionExternalGenerationIdentityFromSession(session as never)!;
      return {
        generationIdentityKey: completionExternalGenerationIdentityKey(identity),
        generationTargetId: 1,
        appSessionId: null,
        target: { alias: 'cost-monitor' },
        mappingState: 'none',
      };
    })) as never,
    listGenerationTargets: () => [{
      id: 1,
      identityKey: completionExternalGenerationIdentityKey(completionExternalGenerationIdentityFromSession({
        tmuxName: 'external-monitor',
        tmux: { socketPath: '/tmp/test', sessionId: '$1', windowId: '@1', paneId: '%1' },
        kind: 'claude',
        agentPid: 101,
        startedAtMs: 1,
      })!),
    }],
    touchObservedGenerations: () => undefined,
    listStaleGenerationCandidates: () => [],
    pruneStaleGenerationCandidates: () => 0,
    generationCount: () => 0,
  });

  resetHostCommandCounters();
  for (let tick = 0; tick < T_MS / C_SCAN_MS; tick += 1) {
    now += C_SCAN_MS;
    await collector.tick();
    if (subscriberPolling) {
      await Promise.all(clients.map(() => external.getExternalCliSessionsDetailed()));
    }
    if (tick % 5 === 0) { await monitor.tick(); monitorTicks += 1; }
    for (const client of clients) applyFrames(client);
  }
  const result = {
    counters: snapshotHostCommandCounters(),
    clients,
    expected: collector.currentSnapshot().rows,
    monitorScannerCalls,
    monitorAdapterCalls,
    monitorTicks,
  };
  stream.dispose();
  collector.dispose();
  return result;
}

test('asserts A-G: production discovery scanners have constant host cost for 1, 10, and 50 stream subscribers', async () => {
  const one = await runScenario(1);
  const ten = await runScenario(10);
  const fifty = await runScenario(50);

  for (const [subscribers, result] of [[1, one], [10, ten], [50, fifty]] as const) {
    assertCostBounds(result.counters, subscribers);
    assert.equal(result.monitorScannerCalls, 4, `assert E: turn monitor scanner was not run with N=${subscribers}`);
    assert.equal(result.monitorAdapterCalls, 4, `assert E: turn monitor activity adapter was not run with N=${subscribers}`);
    assert.equal(result.monitorTicks, 4, `assert E: turn monitor was not run with N=${subscribers}`);
    for (const client of result.clients) {
      assert.deepEqual([...client.rows.values()], result.expected, `assert F: subscriber missed latest snapshot/delta (N=${subscribers})`);
    }
  }
  for (const key of Object.keys(K_KEY_PER_S)) {
    assert.ok((ten.counters[key] ?? 0) <= (one.counters[key] ?? 0) + 2, `assert B: ${key} grew from N=1 to N=10`);
    assert.ok((fifty.counters[key] ?? 0) <= (one.counters[key] ?? 0) + 2, `assert B: ${key} grew from N=1 to N=50`);
  }
  assert.equal(one.counters['tmux capture-pane'], fifty.counters['tmux capture-pane'], 'assert C: capture cost must be active-pane, not subscriber, scoped');
  assert.equal(fifty.clients.length, 50, 'assert G: all virtual browser subscriptions were created');
});

test('cost bounds fail when subscriber polling calls the production external scanner', async () => {
  const polluted = await runScenario(50, true);
  assert.throws(() => assertCostBounds(polluted.counters, 50), /assert A/);
});

test('U16: discovery polling never runs unconditionally', async () => {
  const pollingSources = await Promise.all([
    '../../../../src/hooks/useProjectsState.ts',
    '../../../../src/components/sidebar/hooks/useExternalCliSessions.ts',
    '../../../../src/components/app/AppContent.tsx',
  ].map((path) => readFile(new URL(path, import.meta.url), 'utf8')));
  const [liveRoster, externalRoster, promotions] = pollingSources;

  for (const [name, source] of [
    ['useProjectsState', liveRoster],
    ['useExternalCliSessions', externalRoster],
  ] as const) {
    assert.match(
      source,
      /if \(streamHealthy\) return undefined;[\s\S]*?window\.setInterval\(/,
      `U16: ${name} REST polling must be skipped while the discovery stream is healthy`,
    );
  }

  // Promotion polling was removed, rather than merely given a different cadence.
  // This rejects equivalent regressions such as setInterval(poll, 2_000), while
  // allowing AppContent's unrelated 5-second running-session database refresh.
  for (const match of promotions.matchAll(/useEffect\(\(\) => \{([\s\S]*?)\n {2}\}, \[/g)) {
    if (!match[1].includes('externalTerminal')) continue;
    assert.doesNotMatch(match[1], /setInterval\s*\(/);
  }
});

test('I11: stream and REST-fallback authority remove a killed live row within T_residue=10,000ms', async () => {
  const T_RESIDUE_MS = 10_000;
  let now = 0;
  let livePresent = true;
  const collector = createDiscoveryCollector({
    now: () => now,
    scanExternal: async () => ({ ok: true, sessions: [] }),
    scanLive: async () => ({ ok: true, sessions: livePresent ? [{
      id: 'live-1', tmuxName: 'live-1', tmux: { socketPath: '/tmp/test', sessionId: '$1', windowId: '@1', paneId: '%11' },
      process: { pid: 11, startedAtMs: 1 }, claim: 'lineage', kind: 'interactive', model: null, effort: null, running: true,
    }] : [], transcriptPaths: new Map() }),
  });
  const stream = createDiscoveryStream(collector, () => now);
  const client: Client = { ws: new FakeWebSocket(), rows: new Map() };
  stream.handle(client.ws as never, { type: 'discovery.subscribe', protocolVersion: 1, lanes: ['live'] });
  await collector.tick();
  applyFrames(client);
  livePresent = false;
  const killedAt = now;
  let removedAt: number | null = null;
  for (let tick = 0; tick < 10; tick += 1) {
    now += C_SCAN_MS;
    await collector.tick();
    applyFrames(client);
    const restFallbackRows = collector.currentSnapshot().rows.filter((row) => row.lane === 'live');
    if (client.rows.size === 0 && restFallbackRows.length === 0) { removedAt = now; break; }
  }
  assert.notEqual(removedAt, null, 'I11: removed live row was never cleared');
  assert.ok(removedAt! - killedAt <= T_RESIDUE_MS, `I11: residue ${removedAt! - killedAt}ms exceeded ${T_RESIDUE_MS}ms`);
  stream.dispose();
  collector.dispose();
});
