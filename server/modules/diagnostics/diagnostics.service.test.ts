import assert from 'node:assert/strict';
import test from 'node:test';

import { getSessionIndexingDiagnostics, type getCachedHostDiscoverySnapshot, type DiscoveryCollector, type DiscoveryRow } from '@/modules/providers/index.js';

import { PROVIDER_CONNECTION_ISSUE_CODES } from "../../../shared/provider-connection.js";

import * as diagnosticsModule from "./diagnostics.service.js";
import {
  createDiagnosticsService,
  DIAGNOSTICS_CACHE_TTL_MS,
  DIAGNOSTICS_MAX_AGE_MS,
  DIAGNOSTICS_MAX_ROWS,
  type DiagnosticsDependencies,
} from './diagnostics.service.js';

const PRIVATE = 'PRIVATE_DIAGNOSTIC_SENTINEL';
type HostDiscoverySnapshot = NonNullable<ReturnType<typeof getCachedHostDiscoverySnapshot>>;
type HostDiscoveryPane = HostDiscoverySnapshot["panes"][number];
type HostDiscoveryProcess = HostDiscoverySnapshot["processes"][number];

function paneFixture() {
  const base = fixture();
  const row: DiscoveryRow = {
    ...base.rows[0], tmux: { socketPath: PRIVATE, sessionId: "$0", windowId: "@0", paneId: "%0" },
    kind: "codex", process: { pid: 12, startedAtMs: 90_000 }, presence: "present", binding: "tagged",
  };
  base.rows.splice(0, base.rows.length, row);
  const panes: HostDiscoveryPane[] = [{
    tmux: row.tmux, pid: 10, name: PRIVATE, command: PRIVATE, cwd: PRIVATE,
    codexThreadId: PRIVATE, taggedKind: PRIVATE, taggedSessionId: PRIVATE,
  }];
  const processes: HostDiscoveryProcess[] = [
    { pid: 10, ppid: 1, comm: PRIVATE, args: PRIVATE },
    { pid: 11, ppid: 10, comm: PRIVATE, args: PRIVATE },
    { pid: 12, ppid: 11, comm: PRIVATE, args: PRIVATE },
  ];
  let host: HostDiscoverySnapshot | null = {
    ok: true, capturedAtMs: 99_500, panes, processes, sockets: [{ index: 0, ok: true, panes }],
  };
  let hostReads = 0;
  const dependencies = {
    collector: base.dependencies.collector,
    host: () => { hostReads++; return host; }, now: base.dependencies.now,
  };
  return {
    ...base, row, panes, processes, dependencies,
    setHost: (value: HostDiscoverySnapshot | null) => { host = value; },
    hostReads: () => hostReads,
    read: () => diagnosticsModule.createPaneDiagnosticsService(dependencies).read(),
  };
}

test("pane projection joins exact socket identities, retains lanes, and exposes only the schema", () => {
  const f = paneFixture();
  f.rows.push({ ...f.row, lane: "live", tmuxActionable: false },
    { ...f.row, tmux: { ...f.row.tmux, socketPath: `${PRIVATE}/other` } });
  const data = f.read();
  assert.deepEqual(data.panes, [
    { paneNumber: 1, socketNumber: 1, captureSlot: 1, sessionId: "$0", windowId: "@0", paneId: "%0", panePid: 10,
      observations: [
        { lane: "external", provider: "codex", presence: "present", freshness: "fresh", activity: "unknown",
          connectionIssue: "transcript_permission_denied", actionabilityReport: "unknown",
          binding: { grade: "tagged", providerSessionReported: true },
          process: { agentPid: 12, generation: "recorded", lineage: { relation: "descendant", reason: null, pids: [10, 11, 12] } } },
        { lane: "live", provider: "codex", presence: "present", freshness: "fresh", activity: "unknown",
          connectionIssue: "transcript_permission_denied", actionabilityReport: "reported_false",
          binding: { grade: "tagged", providerSessionReported: true },
          process: { agentPid: 12, generation: "recorded", lineage: { relation: "descendant", reason: null, pids: [10, 11, 12] } } },
      ] },
    { paneNumber: 2, socketNumber: 2, captureSlot: null, sessionId: "$0", windowId: "@0", paneId: "%0", panePid: null,
      observations: [{ lane: "external", provider: "codex", presence: "present", freshness: "fresh", activity: "unknown",
        connectionIssue: "transcript_permission_denied", actionabilityReport: "unknown",
        binding: { grade: "tagged", providerSessionReported: true },
        process: { agentPid: 12, generation: "recorded", lineage: { relation: "unknown", reason: "pane_not_observed", pids: [] } } }] },
  ]);
  assert.deepEqual(Object.keys(data).sort(), ["schemaVersion", "generatedAtMs", "cacheTtlMs", "staleAfterMs", "collector", "host", "limits", "coverage", "panes"].sort());
  assert.deepEqual(data.collector, { status: "available", freshness: "fresh", scanAgeMs: 1000, fullScanAgeMs: 2000,
    lanes: { external: { status: "ok", consecutiveFailures: 0, rows: 2, staleRows: 0 }, live: { status: "ok", consecutiveFailures: 0, rows: 1, staleRows: 0 } } });
  assert.deepEqual(data.host, { freshness: "fresh", ageMs: 500, capture: "ok", failure: null,
    sockets: [{ slot: 1, capture: "ok", reason: null, paneCount: 1 }] });
  assert.doesNotMatch(JSON.stringify(data), /PRIVATE_DIAGNOSTIC_SENTINEL|socketPath|startedAtMs|tmuxName|providerSessionId|cwd|argv|comm|transcriptPaths|inventoryKey|capability|token/);
});

test("pane cache is independent, expires at 2000ms and rollback, and never invokes capture", () => {
  const f = paneFixture();
  const service = diagnosticsModule.createPaneDiagnosticsService(f.dependencies);
  const first = service.read();
  f.setNow(101_999);
  assert.equal(service.read(), first);
  assert.equal(f.reads(), 1);
  assert.equal(f.hostReads(), 1);
  f.setNow(102_000);
  const second = service.read();
  assert.notEqual(second, first);
  f.setNow(50_000);
  assert.notEqual(service.read(), second);
  assert.equal(f.reads(), 3);
  assert.equal(f.hostReads(), 3);
});

test("pane coordinates reject coercible objects instead of serializing raw source values", () => {
  const f = paneFixture();
  const coordinate = { toString: () => "$0", endsWith: () => false, toJSON: () => PRIVATE };
  f.rows[0] = { ...f.row, tmux: Object.assign({}, f.row.tmux, { sessionId: coordinate }) };
  const data = f.read();
  assert.deepEqual(data.panes, []);
  assert.equal(data.coverage.invalidRowsOmitted, 1);
  assert.doesNotMatch(JSON.stringify(data), new RegExp(PRIVATE));
});

test("pane projections preserve valid boundary PIDs, coordinates, providers and activities", () => {
  for (const pid of [1, 2147483647]) {
    const f = paneFixture();
    f.rows[0] = { ...f.row, process: { pid, startedAtMs: 90_000 },
      tmux: { ...f.row.tmux, sessionId: "$1234567890", windowId: "@1234567890", paneId: "%1234567890" } };
    assert.equal(f.read().panes[0].observations[0].process.agentPid, pid);
  }
  for (const provider of ["claude", "codex", "cursor", "opencode", "omp", "omo", "gjc", "ssh", "shell", "unknown"]) {
    const f = paneFixture();
    f.rows[0] = { ...f.row, kind: provider };
    assert.equal(f.read().panes[0].observations[0].provider, provider);
  }
  for (const activity of ["running", "waiting_user", "asking_user", "error", "unknown"] as const) {
    const f = paneFixture();
    f.rows[0] = { ...f.row, activity };
    assert.equal(f.read().panes[0].observations[0].activity, activity);
  }
});

test("pane ordinals are sample-local and duplicate lanes do not create extra claims", () => {
  const f = paneFixture();
  const other = { ...f.row, tmux: { ...f.row.tmux, socketPath: "other", paneId: "%2" } };
  f.rows.push(other, { ...f.row, lane: "live" }, f.row);
  const service = diagnosticsModule.createPaneDiagnosticsService(f.dependencies);
  assert.equal(service.read().panes[0].observations.length, 2);
  f.rows.reverse();
  f.rows.shift();
  f.rows.shift();
  f.setNow(102_000);
  const data = service.read();
  assert.equal(data.panes[0].paneId, "%2");
  assert.equal(data.panes[0].paneNumber, 1);
  assert.equal(data.panes[0].socketNumber, 1);
});

test("invalid lane or presence is omitted and not promoted to a known observation", () => {
  for (const invalid of [{ lane: PRIVATE }, { presence: PRIVATE }]) {
    const f = paneFixture();
    f.rows[0] = Object.assign({}, f.row, invalid);
    const data = f.read();
    assert.deepEqual(data.panes, []);
    assert.equal(data.coverage.invalidRowsOmitted, 1);
  }
});

test("generation strings and invalid timestamps remain unknown and never leave the response", () => {
  for (const startedAtMs of [PRIVATE, -1, NaN, Infinity, 100_001]) {
    const f = paneFixture();
    f.rows[0] = Object.assign({}, f.row, { process: { pid: 12, startedAtMs } });
    const data = f.read();
    assert.equal(data.panes[0].observations[0].process.generation, "unknown");
    assert.equal(data.panes[0].observations[0].process.lineage.reason, "process_not_recorded");
    assert.doesNotMatch(JSON.stringify(data), new RegExp(PRIVATE));
  }
});

test("invalid and missing full-scan or host timestamps do not fabricate fresh evidence", () => {
  for (const timestamp of [-1, NaN, Infinity, 100_001]) {
    const f = paneFixture();
    f.state.lastFullScanAtMs = timestamp;
    f.setHost({ ok: true, capturedAtMs: timestamp, panes: f.panes, processes: f.processes });
    const data = f.read();
    assert.equal(data.panes[0].observations[0].freshness, "unknown");
    assert.equal(data.host.freshness, "unavailable");
    assert.equal(data.panes[0].observations[0].process.lineage.reason, "host_unavailable");
  }
  const f = paneFixture();
  const collector = f.dependencies.collector();
  assert.ok(collector);
  delete collector.getState;
  assert.equal(f.read().panes[0].observations[0].freshness, "unknown");
});

test("evidence outside pane/process budgets remains unknown, including an absent root roster entry", () => {
  const f = paneFixture();
  f.processes.shift();
  assert.equal(f.read().panes[0].observations[0].process.lineage.reason, "ancestry_incomplete");
  f.processes.splice(0, f.processes.length, ...Array.from({ length: 8192 }, (_, i) => ({ pid: i + 100, ppid: 0, comm: PRIVATE })), { pid: 12, ppid: 10, comm: PRIVATE });
  assert.equal(f.read().panes[0].observations[0].process.lineage.reason, "process_not_observed");
  f.panes.unshift(...Array.from({ length: 1000 }, (_, i) => ({ ...f.panes[0], tmux: { ...f.row.tmux, paneId: `%${i + 1}` } })));
  const data = f.read();
  assert.equal(data.panes[0].observations[0].process.lineage.reason, "pane_not_observed");
  assert.equal(data.panes[0].captureSlot, null);
  assert.equal(data.coverage.hostPanesOmitted, 1);
  assert.equal(data.coverage.hostProcessesOmitted, 1);
});

test("socket issue allowlist and all excluded raw fields stay private", () => {
  const f = paneFixture();
  const raw = { socketPath: PRIVATE, socketName: PRIVATE, tmuxName: PRIVATE, cwd: PRIVATE,
    argv: PRIVATE, comm: PRIVATE, providerSessionId: PRIVATE, transcriptPath: PRIVATE, transcriptPaths: PRIVATE,
    transcriptContent: PRIVATE, generation: PRIVATE, inventoryKey: PRIVATE, error: PRIVATE,
    credential: PRIVATE, token: PRIVATE, capability: PRIVATE };
  f.rows[0] = Object.assign({}, raw, f.row);
  for (const reason of ["configuration_invalid", "socket_unavailable", "socket_identity_changed", "capture_failed", "cancelled", PRIVATE]) {
    const socket = { index: 0, ok: false, panes: [] };
    const sample: HostDiscoverySnapshot = { ok: false, capturedAtMs: 99_500, panes: [], processes: [], sockets: [socket] };
    Object.assign(socket, raw, { reason });
    Object.assign(sample, raw, { failure: reason });
    f.setHost(sample);
    const data = f.read();
    assert.equal(data.host.failure, reason === PRIVATE ? "unknown" : reason);
    assert.equal(data.host.sockets[0].reason, reason === PRIVATE ? "unknown" : reason);
    assert.doesNotMatch(JSON.stringify(data), new RegExp(PRIVATE));
  }
});

for (const [field, values] of [
  ["sessionId", ["$", "$12345678901", "$1\n", "$1\r", "$1\u2028", " $1", "$１", PRIVATE]],
  ["windowId", ["@", "@-1", "@12345678901", "@1\r", PRIVATE]],
  ["paneId", ["%", "%1.0", "%12345678901", "%1\r", PRIVATE]],
] as const) {
  for (const value of values) test(`pane coordinates omit invalid ${field}=${JSON.stringify(value)}`, () => {
    const f = paneFixture();
    f.rows[0] = { ...f.row, tmux: { ...f.row.tmux, [field]: value } };
    const data = f.read();
    assert.deepEqual(data.panes, []);
    assert.equal(data.coverage.invalidRowsOmitted, 1);
    assert.equal(data.coverage.rowsOmitted, 0);
  });
}

for (const pid of [0, -1, 1.5, NaN, Infinity, 2147483648]) test(`pane PID allowlist rejects ${pid}`, () => {
  const f = paneFixture();
  f.rows[0] = { ...f.row, process: { pid, startedAtMs: 90_000 } };
  f.panes[0].pid = pid;
  const pane = f.read().panes[0];
  assert.equal(pane.panePid, null);
  assert.equal(pane.observations[0].process.agentPid, null);
  assert.equal(pane.observations[0].process.generation, "unknown");
});

for (const grade of ["tagged", "observed", "inferred", undefined, PRIVATE]) test(`pane binding allowlist ${grade}`, () => {
  const f = paneFixture();
  f.rows[0] = Object.assign({}, f.row, { binding: grade });
  assert.equal(f.read().panes[0].observations[0].binding.grade, grade === undefined || grade === PRIVATE ? "unknown" : grade);
});

test("pane enum and boolean projection rejects private values without inventing authority", () => {
  const f = paneFixture();
  f.rows[0] = Object.assign({}, f.row, { kind: PRIVATE, activity: PRIVATE, connectionIssue: PRIVATE, tmuxActionable: PRIVATE });
  const observation = f.read().panes[0].observations[0];
  assert.equal(observation.provider, "unknown");
  assert.equal(observation.activity, "unknown");
  assert.equal(observation.connectionIssue, "unknown");
  assert.equal(observation.actionabilityReport, "unknown");
  assert.doesNotMatch(JSON.stringify(observation), new RegExp(PRIVATE));
  for (const id of [null, "", `idle-gjc:${PRIVATE}`]) {
    f.rows[0] = { ...f.row, providerSessionId: id };
    assert.equal(f.read().panes[0].observations[0].binding.providerSessionReported, false);
  }
  for (const issue of PROVIDER_CONNECTION_ISSUE_CODES) {
    f.rows[0] = { ...f.row, connectionIssue: issue, tmuxActionable: true };
    const value = f.read().panes[0].observations[0];
    assert.equal(value.connectionIssue, issue);
    assert.equal(value.actionabilityReport, "reported_true");
  }
});

for (const scenario of ["root", "descendant", "missing", "cycle", "older", "absent", "unrecorded", "host", "different", "limit", "32", "outside"] as const) {
  test(`cached lineage ${scenario} reports only observed root-to-agent evidence`, () => {
    const f = paneFixture();
    let reason: string | null = null;
    let pids = [10, 11, 12];
    if (scenario === "root") { f.rows[0] = { ...f.row, process: { pid: 10, startedAtMs: 90_000 } }; pids = [10]; }
    if (scenario === "missing") { f.processes.splice(1, 1); reason = "ancestry_incomplete"; }
    if (scenario === "cycle") { f.processes[1].ppid = 12; reason = "ancestry_cycle"; }
    if (scenario === "older") { f.rows[0] = { ...f.row, process: { pid: 12, startedAtMs: 99_501 } }; reason = "sample_predates_generation"; }
    if (scenario === "absent") { f.processes.pop(); reason = "process_not_observed"; }
    if (scenario === "unrecorded") { f.rows[0] = { ...f.row, process: null }; reason = "process_not_recorded"; }
    if (scenario === "host") { f.setHost(null); reason = "host_unavailable"; }
    if (scenario === "different") { f.panes[0] = { ...f.panes[0], tmux: { ...f.row.tmux, socketPath: "other" } }; reason = "pane_not_observed"; }
    if (scenario === "outside") { f.processes[1].ppid = 0; reason = "not_in_pane_chain"; }
    if (scenario === "limit" || scenario === "32") {
      const length = scenario === "limit" ? 33 : 32;
      f.processes.splice(0, f.processes.length, ...Array.from({ length }, (_, i) => ({ pid: 10 + i, ppid: 9 + i, comm: PRIVATE })));
      f.rows[0] = { ...f.row, process: { pid: 9 + length, startedAtMs: 90_000 } };
      pids = Array.from({ length }, (_, i) => 10 + i);
      if (scenario === "limit") reason = "ancestry_limit";
    }
    assert.deepEqual(f.read().panes[0].observations[0].process.lineage,
      reason ? { relation: "unknown", reason, pids: [] } : { relation: scenario === "root" ? "pane_root" : "descendant", reason: null, pids });
  });
}

for (const scenario of ["fresh", "fullExpired", "scanExpired", "failing", "degraded", "retained", "unknown", "boundary"] as const) {
  test(`pane observation freshness ${scenario} is independent of host freshness`, () => {
    const f = paneFixture();
    if (scenario === "fullExpired") f.state.lastFullScanAtMs = 69_999;
    if (scenario === "scanExpired") f.detailed.takenAtMs = 69_999;
    if (scenario === "failing") f.detailed.external.ok = false;
    if (scenario === "degraded") f.health.external.ok = false;
    if (scenario === "retained") f.rows[0] = { ...f.row, presence: "stale" };
    if (scenario === "unknown") f.detailed.takenAtMs = null;
    if (scenario === "boundary") { f.detailed.takenAtMs = 70_000; f.state.lastFullScanAtMs = 70_000; }
    const data = f.read();
    assert.equal(data.panes[0].observations[0].freshness, scenario === "fresh" || scenario === "boundary" ? "fresh" : scenario === "unknown" ? "unknown" : "stale");
    assert.equal(data.host.freshness, "fresh");
  });
}

test("pane coverage bounds all inspected arrays and separates invalid and budget omission", () => {
  const f = paneFixture();
  f.rows.splice(0, 1, ...Array.from({ length: 1001 }, (_, i) => ({ ...f.row, tmux: { ...f.row.tmux, paneId: `%${i}` } })));
  f.rows[1] = { ...f.row, tmux: { ...f.row.tmux, paneId: PRIVATE } };
  f.panes.push(...Array.from({ length: 1000 }, (_, i) => ({ ...f.panes[0], tmux: { ...f.row.tmux, paneId: `%${i + 1}` } })));
  f.processes.push(...Array.from({ length: 8190 }, (_, i) => ({ pid: i + 100, ppid: 0, comm: PRIVATE })));
  Object.defineProperty(f.rows, 1000, { get: () => assert.fail("row budget exceeded") });
  Object.defineProperty(f.panes, 1000, { get: () => assert.fail("pane budget exceeded") });
  Object.defineProperty(f.processes, 8192, { get: () => assert.fail("process budget exceeded") });
  const data = f.read();
  assert.deepEqual(data.limits, { discoveryRows: 1000, hostPanes: 1000, hostProcesses: 8192, lineagePids: 32 });
  assert.deepEqual(data.coverage, { totalRows: 1001, rowsInspected: 1000, rowsOmitted: 1, invalidRowsOmitted: 1, hostPanesOmitted: 1, hostProcessesOmitted: 1, countsCapped: false });
  assert.equal(data.panes.length, 999);
});

test("pane counts cap at one million with explicit countsCapped", () => {
  const f = paneFixture();
  f.rows.length = 2_000_001;
  f.rows.fill(f.row, 0, 1000);
  f.state.consecutiveFailures.external = 2_000_000;
  const data = f.read();
  assert.equal(data.coverage.totalRows, 1_000_000);
  assert.equal(data.coverage.rowsOmitted, 1_000_000);
  assert.equal(data.coverage.countsCapped, true);
  assert.equal(data.collector.lanes.external.consecutiveFailures, 1_000_000);
  assert.equal(data.panes[0].observations.length, 1);
});

test("pane source failures are explicit, independent, private and cached", () => {
  const f = paneFixture();
  let failures = 0;
  f.dependencies.host = () => { failures++; throw new Error(PRIVATE); };
  const service = diagnosticsModule.createPaneDiagnosticsService(f.dependencies);
  const data = service.read();
  assert.equal(data.collector.status, "available");
  assert.deepEqual(data.host, { freshness: "unavailable", ageMs: null, capture: "unknown", failure: null, sockets: [] });
  assert.equal(service.read(), data);
  assert.equal(failures, 1);
  f.dependencies.collector = () => { throw new Error(PRIVATE); };
  const unavailable = f.read();
  assert.equal(unavailable.collector.status, "unavailable");
  assert.equal(unavailable.coverage.totalRows, null);
  assert.deepEqual(unavailable.panes, []);
  assert.doesNotMatch(JSON.stringify(unavailable), new RegExp(PRIVATE));
});

test("host capture failure, partial slots and ages never guess a failed socket mapping", () => {
  const f = paneFixture();
  f.setHost({ ok: false, capturedAtMs: 99_500, panes: f.panes, processes: f.processes,
    sockets: [{ index: 0, ok: false, panes: [], reason: "socket_unavailable" }, { index: 1, ok: true, panes: f.panes }] });
  const data = f.read();
  assert.equal(data.host.capture, "partial");
  assert.equal(data.panes[0].captureSlot, 2);
  assert.deepEqual(data.host.sockets[0], { slot: 1, capture: "unavailable", reason: "socket_unavailable", paneCount: 0 });
  f.setHost({ ok: false, capturedAtMs: 99_500, failure: "capture_failed", panes: [], processes: [] });
  assert.equal(f.read().host.capture, "failed");
  assert.equal(f.read().host.freshness, "fresh");
  assert.equal(f.read().panes[0].captureSlot, null);
  f.setHost({ ok: true, capturedAtMs: 69_999, panes: f.panes, processes: f.processes });
  assert.equal(f.read().host.freshness, "stale");
  f.setNow(DIAGNOSTICS_MAX_AGE_MS * 2);
  assert.equal(f.read().host.ageMs, DIAGNOSTICS_MAX_AGE_MS);
});

test("pane reads preserve the aggregate response with identical clock and sources", () => {
  const f = paneFixture();
  const before = f.service.read();
  f.read();
  const after = createDiagnosticsService({ ...fixture().dependencies, collector: f.dependencies.collector }).read();
  assert.deepEqual(after, before);
});

function fixture() {
  let now = 100_000;
  let reads = 0;
  let indexingReads = 0;
  const rows: DiscoveryRow[] = [{
    key: PRIVATE, lane: 'external', tmuxName: PRIVATE,
    tmux: { socketPath: PRIVATE, sessionId: PRIVATE, windowId: PRIVATE, paneId: PRIVATE },
    process: { pid: 987654, startedAtMs: 123 }, kind: PRIVATE,
    providerSessionId: PRIVATE, cwd: PRIVATE, lastSeenRevision: 1,
    presence: 'stale', staleSinceRevision: 1, activity: 'unknown',
    connectionIssue: 'transcript_permission_denied',
  }];
  const detailed = {
    takenAtMs: 99_000 as number | null,
    external: { ok: true, sessions: [], rawError: PRIVATE },
    live: { ok: true, sessions: [], transcriptPaths: new Map([[PRIVATE, PRIVATE]]) },
  };
  const state = {
    running: true, active: false, scanning: false, disposed: false,
    lastFullScanAtMs: 98_000, consecutiveFailures: { external: 0, live: 0 },
    argv: PRIVATE,
  };
  const health = {
    external: { ok: true, lastOkRevision: 1, consecutiveFailures: 0 },
    live: { ok: true, lastOkRevision: 1, consecutiveFailures: 0 },
  };
  const collector: Pick<DiscoveryCollector, 'currentSnapshot' | 'currentDetailed' | 'getState'> = {
    currentSnapshot: () => { reads++; return { epoch: PRIVATE, revision: 1, takenAtMs: 99_000, rows, health }; },
    currentDetailed: () => detailed,
    getState: () => state,
  };
  const watcher = { ok: true, degraded: false, consecutiveFailures: 0, enospcObserved: false, token: PRIVATE };
  const indexing = {
    pending: 12, active: 3, maxPending: 448, maxActive: 4,
    reconciling: 1, reconciliationPending: 2, overflowed: 25, failures: 6, closed: false,
    transcriptPaths: [PRIVATE], rawError: PRIVATE, token: PRIVATE,
    reconcile: () => assert.fail('diagnostics must never reconcile'),
  };
  const dependencies: DiagnosticsDependencies = {
    collector: () => collector, watcher: () => watcher,
    indexing: () => { indexingReads++; return indexing; }, now: () => now, eventLoopUtilization: () => 0.123456,
  };
  return {
    rows, detailed, state, health, watcher, indexing, dependencies,
    indexingReads: () => indexingReads,
    setNow: (value: number) => { now = value; }, reads: () => reads,
    service: createDiagnosticsService(dependencies),
  };
}

test('cached reads project only allowlisted aggregate fields and bounded platform utilization', () => {
  const subject = fixture();
  const data = subject.service.read();
  assert.equal(data.collector.mode, 'idle');
  assert.equal(data.collector.freshness, 'fresh');
  assert.equal(data.collector.scanAgeMs, 1_000);
  assert.equal(data.collector.fullScanAgeMs, 2_000);
  assert.deepEqual(data.collector.lanes.external, { status: 'ok', consecutiveFailures: 0, rows: 1, staleRows: 1 });
  assert.deepEqual(data.collector.connectionIssues, [{ code: 'transcript_permission_denied', count: 1 }]);
  assert.equal(data.gjcWatcher.status, 'no_failures_reported');
  assert.equal(data.eventLoop.utilization, 0.1235);
  assert.deepEqual(data.indexing, {
    status: 'accepting', pending: 12, active: 3, maxPending: 448, maxActive: 4,
    reconciling: 1, reconciliationPending: 2, overflowed: 25, failures: 6,
  });
  const json = JSON.stringify(data);
  assert.ok(json.length < 2_000);
  assert.doesNotMatch(json, /PRIVATE_DIAGNOSTIC_SENTINEL|987654|socketPath|providerSessionId|transcriptPaths|argv|rawError|token|cwd|epoch/);
});

test('all callers share a two-second cache without invoking collector mutations', () => {
  const subject = fixture();
  const first = subject.service.read();
  subject.state.consecutiveFailures.external = 1;
  subject.indexing.pending = 44;
  subject.setNow(100_000 + DIAGNOSTICS_CACHE_TTL_MS - 1);
  for (let i = 0; i < 20; i++) assert.equal(subject.service.read(), first);
  assert.equal(subject.reads(), 1);
  assert.equal(subject.indexingReads(), 1);
  assert.equal(first.indexing.pending, 12);
  subject.setNow(100_000 + DIAGNOSTICS_CACHE_TTL_MS);
  const second = subject.service.read();
  assert.notEqual(second, first);
  assert.equal(second.collector.lanes.external.status, 'failing');
  assert.equal(first.collector.lanes.external.consecutiveFailures, 0);
  assert.equal(subject.reads(), 2);
  assert.equal(subject.indexingReads(), 2);
  assert.equal(second.indexing.pending, 44);
  subject.setNow(50_000);
  assert.notEqual(subject.service.read(), second, 'clock rollback must expire the cache');
});

test('bootstrap, stale observations, failed lanes, and successful full scan ages remain distinct', () => {
  const subject = fixture();
  subject.detailed.takenAtMs = null;
  assert.equal(subject.service.read().collector.freshness, 'waiting');
  subject.setNow(150_000);
  subject.detailed.takenAtMs = 99_000;
  subject.detailed.external.ok = false;
  subject.state.consecutiveFailures.external = 4;
  const failing = subject.service.read().collector;
  assert.equal(failing.freshness, 'stale');
  assert.equal(failing.lanes.external.status, 'failing');
  assert.equal(failing.lanes.external.consecutiveFailures, 4);
  assert.equal(failing.fullScanAgeMs, 52_000);
  subject.health.external.ok = false;
  subject.setNow(152_000);
  assert.equal(subject.service.read().collector.lanes.external.status, 'degraded');
});

test('unknown reasons are omitted and retained row work and response size stay bounded', () => {
  const subject = fixture();
  subject.rows.push({ ...subject.rows[0], connectionIssue: PRIVATE } as unknown as DiscoveryRow);
  subject.rows.push(...Array.from({ length: 2_000 }, () => subject.rows[0]));
  const data = subject.service.read();
  assert.equal(data.collector.rowsTruncated, true);
  assert.equal(data.collector.lanes.external.rows, DIAGNOSTICS_MAX_ROWS);
  assert.deepEqual(data.collector.connectionIssues, [{ code: 'transcript_permission_denied', count: DIAGNOSTICS_MAX_ROWS - 1 }]);
  assert.doesNotMatch(JSON.stringify(data), new RegExp(PRIVATE));
});

test('source failures remain independent, generic, cached, and silent', () => {
  const subject = fixture();
  subject.dependencies.collector = () => { throw new Error(PRIVATE); };
  let calls = 0;
  subject.dependencies.watcher = () => { calls++; throw new Error(PRIVATE); };
  subject.dependencies.eventLoopUtilization = () => { throw new Error(PRIVATE); };
  const service = createDiagnosticsService(subject.dependencies);
  const data = service.read();
  assert.equal(data.collector.status, 'unavailable');
  assert.equal(data.gjcWatcher.status, 'unavailable');
  assert.equal(data.eventLoop.utilization, null);
  assert.equal(service.read(), data);
  assert.equal(calls, 1);
  assert.doesNotMatch(JSON.stringify(data), new RegExp(PRIVATE));
  subject.dependencies.watcher = () => subject.watcher;
  subject.setNow(102_000);
  assert.equal(service.read().gjcWatcher.status, 'no_failures_reported');
});

test('watcher degradation and watch limits are reported without claiming liveness', () => {
  const subject = fixture();
  subject.watcher.ok = false;
  subject.watcher.consecutiveFailures = 3;
  assert.equal(subject.service.read().gjcWatcher.status, 'retrying');
  subject.watcher.degraded = true;
  subject.watcher.enospcObserved = true;
  subject.watcher.consecutiveFailures = 9_999_999;
  subject.setNow(102_000);
  assert.deepEqual(subject.service.read().gjcWatcher, {
    status: 'degraded', consecutiveFailures: 1_000_000, watchLimitObserved: true,
  });
});

test('invalid numeric signals are unavailable and observation ages are capped', () => {
  for (const timestamp of [NaN, Infinity, -1, 100_001]) {
    const subject = fixture();
    subject.detailed.takenAtMs = timestamp;
    subject.state.consecutiveFailures.external = NaN;
    subject.dependencies.eventLoopUtilization = () => Infinity;
    const data = createDiagnosticsService(subject.dependencies).read();
    assert.equal(data.collector.scanAgeMs, null);
    assert.equal(data.collector.freshness, 'unavailable');
    assert.equal(data.collector.lanes.external.consecutiveFailures, 0);
    assert.equal(data.eventLoop.utilization, null);
  }
  const subject = fixture();
  subject.setNow(DIAGNOSTICS_MAX_AGE_MS * 2);
  assert.equal(subject.service.read().collector.scanAgeMs, DIAGNOSTICS_MAX_AGE_MS);
});

test('missing collector accessors remain unknown and stopped/disposed state is explicit', () => {
  const subject = fixture();
  subject.state.running = false;
  assert.equal(subject.service.read().collector.mode, 'stopped');
  subject.state.disposed = true;
  subject.setNow(102_000);
  assert.equal(subject.service.read().collector.mode, 'disposed');
  const collector = subject.dependencies.collector();
  assert.ok(collector);
  delete collector.getState;
  subject.setNow(104_000);
  assert.equal(subject.service.read().collector.mode, 'unknown');
});


test('optional or failed indexing metadata is unavailable, cached, and independent of other sources', () => {
  for (const source of [undefined, () => null, () => undefined, () => { throw new Error(PRIVATE); }]) {
    const subject = fixture();
    subject.dependencies.indexing = source;
    const service = createDiagnosticsService(subject.dependencies);
    const data = service.read();
    assert.deepEqual(data.indexing, {
      status: 'unavailable', pending: null, active: null, maxPending: null, maxActive: null,
      reconciling: null, reconciliationPending: null, overflowed: null, failures: null,
    });
    assert.equal(data.collector.status, 'available');
    assert.equal(data.gjcWatcher.status, 'no_failures_reported');
    assert.equal(data.eventLoop.utilization, 0.1235);
    assert.equal(service.read(), data);
    assert.doesNotMatch(JSON.stringify(data), new RegExp(PRIVATE));
  }
});

test('indexing counters have explicit bounds and invalid values remain unknown instead of healthy zero', () => {
  const subject = fixture();
  Object.assign(subject.indexing, {
    pending: 5.9, active: -1, maxPending: Infinity, maxActive: undefined,
    reconciling: NaN, reconciliationPending: PRIVATE, overflowed: Number.MAX_SAFE_INTEGER, failures: -9,
    closed: PRIVATE,
  });
  assert.deepEqual(subject.service.read().indexing, {
    status: 'unavailable', pending: 5, active: null, maxPending: null, maxActive: null,
    reconciling: null, reconciliationPending: null, overflowed: 1_000_000, failures: null,
  });
});

test('indexing admission is independent of activity and only allowlisted properties are accessed', () => {
  const subject = fixture();
  Object.defineProperty(subject.indexing, 'filePaths', { enumerable: true, get: () => assert.fail('must not inspect private paths') });
  subject.indexing.active = 0;
  subject.indexing.pending = 0;
  assert.equal(subject.service.read().indexing.status, 'accepting', 'idle or paused admission is not liveness');
  subject.indexing.closed = true;
  subject.indexing.active = 2;
  subject.setNow(102_000);
  assert.equal(subject.service.read().indexing.status, 'closed');
  assert.equal(subject.service.read().indexing.active, 2, 'closed admission may still be draining active work');
});

test('providers export cached indexing metadata without starting watchers or including bulk synchronization', () => {
  const subject = fixture();
  subject.dependencies.indexing = getSessionIndexingDiagnostics;
  const data = createDiagnosticsService(subject.dependencies).read();
  assert.deepEqual(data.indexing, {
    status: 'closed', pending: 0, active: 0, maxPending: 448, maxActive: 4,
    reconciling: 0, reconciliationPending: 0, overflowed: 0, failures: 0,
  });
});
