import assert from 'node:assert/strict';
import test from 'node:test';

import { boundCatalogMaterial, CATALOG_BODY_BUDGET_BYTES, measureCatalogBody } from '../catalog/bounds.js';
import { FleetCatalogParseError, parseFleetCatalogSnapshot } from '../catalog/schema.js';
import type { FleetCatalogMaterial, FleetCatalogPane, FleetCatalogProject, FleetCatalogSession } from '../catalog/types.js';
import { encodeFleetFrame, FLEET_MAX_FRAME_BYTES } from '../protocol/codec.js';

const HOST = '10000000-0000-4000-8000-000000000001';

function project(index: number, isStarred = false): FleetCatalogProject {
  return { localId: `project-${index}`, path: `/home/owner/workspace/project-${index}`, displayName: `project-${index}`, isStarred };
}
function session(index: number, projectIndex: number, lastActivityMs: number, summaryLength = 120): FleetCatalogSession {
  return { localId: `session-${index}`, projectLocalId: `project-${projectIndex}`, provider: 'codex', summary: 's'.repeat(summaryLength), lastActivityMs };
}
function pane(index: number, presence: 'present' | 'stale' = 'present'): FleetCatalogPane {
  return {
    localId: `pane-${index}`, lane: 'external', tmuxName: `agent-${index}`,
    tmux: { socketPath: '/tmp/tmux-1000/default', sessionId: `$${index}`, windowId: `@${index}`, paneId: `%${index}` },
    process: { pid: 1000 + index, startedAtMs: 1_700_000_000_000 + index }, kind: 'codex', providerSessionId: null,
    activity: 'idle', cwd: `/home/owner/workspace/project-${index}`, presence,
  };
}
function material(overrides: Partial<FleetCatalogMaterial> = {}): FleetCatalogMaterial {
  return {
    host: { hostId: HOST, displayLabel: 'peer', capabilities: ['catalog.read'] },
    projects: [project(1), project(2)],
    sessions: [session(1, 1, 10), session(2, 2, 20)],
    panes: [pane(1)],
    health: { external: { ok: true, lastOkRevision: 1, consecutiveFailures: 0 }, live: { ok: true, lastOkRevision: 1, consecutiveFailures: 0 } },
    processing: [],
    ...overrides,
  };
}
function eventFrame(body: unknown) {
  return { kind: 'event', protocolVersion: 'fleet/1', connectionGeneration: 1, eventId: '9c0c2c2e-4a2d-4c7a-9a6b-2d1f1e0a5b77', event: 'catalog.snapshot', hostId: HOST, body } as never;
}

test('a small catalog is published whole, newest session first, without an omitted marker', () => {
  const bounded = boundCatalogMaterial(material());
  assert.equal(bounded.omitted, undefined);
  assert.deepEqual(bounded.material.sessions.map((row) => row.localId), ['session-2', 'session-1']);
  assert.deepEqual(bounded.material.projects.map((row) => row.localId), ['project-1', 'project-2']);
  assert.ok(measureCatalogBody({ epoch: 'e', revision: 1, ...bounded.material }) <= CATALOG_BODY_BUDGET_BYTES);
});

test('a session table far larger than one frame is trimmed to the most recent sessions and their projects, and fits the frame', () => {
  const projects = Array.from({ length: 600 }, (_row, index) => project(index, index % 100 === 0));
  const sessions = Array.from({ length: 3_000 }, (_row, index) => session(index, index % 300, 1_000_000 + index, 250));
  const panes = [pane(1), pane(2), pane(3, 'stale')];
  const bounded = boundCatalogMaterial(material({ projects, sessions, panes }));

  const snapshot = { epoch: 'epoch-1', revision: 1, ...bounded.material, omitted: bounded.omitted };
  assert.ok(measureCatalogBody(snapshot) <= CATALOG_BODY_BUDGET_BYTES, 'body respects the budget');
  assert.doesNotThrow(() => encodeFleetFrame(eventFrame(snapshot)), 'the whole event fits the frame bound');
  assert.ok(Buffer.byteLength(encodeFleetFrame(eventFrame(snapshot))) <= FLEET_MAX_FRAME_BYTES);

  assert.ok(bounded.omitted !== undefined);
  assert.equal(bounded.omitted.sessions, 3_000 - bounded.material.sessions.length);
  assert.equal(bounded.omitted.projects, 600 - bounded.material.projects.length);
  assert.ok(bounded.material.sessions.length > 50, `kept ${bounded.material.sessions.length} sessions`);
  const kept = bounded.material.sessions.map((row) => row.lastActivityMs);
  assert.deepEqual(kept, [...kept].sort((left, right) => right - left), 'newest first');
  assert.equal(kept[0], 1_000_000 + 2_999, 'the most recent session survives');
  const referenced = new Set(bounded.material.sessions.map((row) => row.projectLocalId));
  for (const row of bounded.material.projects) assert.ok(referenced.has(row.localId) || row.isStarred, `${row.localId} is referenced or starred`);
  for (const id of referenced) assert.ok(bounded.material.projects.some((row) => row.localId === id), `${id} kept for its sessions`);
  assert.deepEqual(bounded.material.panes.map((row) => row.localId), ['pane-1', 'pane-2'], 'present panes stay; the stale pane goes before any session');
  assert.equal(bounded.omitted.panes, 1);
});

test('rows leave in the documented order: unreferenced projects, stale panes, oldest sessions, starred projects, present panes last', () => {
  const base = material({
    projects: [project(1), project(2), project(3), project(9, true)],
    sessions: [session(1, 1, 10), session(2, 2, 20)],
    panes: [pane(1), pane(2, 'stale')],
  });
  const full = measureCatalogBody({ ...base });
  const step = (budget: number) => boundCatalogMaterial(base, { budgetBytes: budget });

  const noUnreferenced = step(full - 1);
  assert.deepEqual(noUnreferenced.material.projects.map((row) => row.localId), ['project-1', 'project-2', 'project-9'], 'the unreferenced unstarred project goes first');
  assert.equal(noUnreferenced.material.panes.length, 2);

  const noStale = step(measureCatalogBody({ ...noUnreferenced.material, omitted: noUnreferenced.omitted }) - 1);
  assert.deepEqual(noStale.material.panes.map((row) => row.localId), ['pane-1'], 'then the stale pane');
  assert.equal(noStale.material.sessions.length, 2);

  const oneSession = step(measureCatalogBody({ ...noStale.material, omitted: noStale.omitted }) - 1);
  assert.deepEqual(oneSession.material.sessions.map((row) => row.localId), ['session-2'], 'then the oldest session');
  assert.deepEqual(oneSession.material.projects.map((row) => row.localId), ['project-2', 'project-9'], 'its project leaves with it; the starred one stays');

  const tiny = step(200);
  assert.deepEqual(tiny.material.sessions, []);
  assert.deepEqual(tiny.material.projects, []);
  assert.ok(tiny.omitted !== undefined && tiny.omitted.sessions === 2 && tiny.omitted.projects === 4);
});

test('counts the source already left out are carried into the marker', () => {
  const bounded = boundCatalogMaterial({ ...material(), omitted: { projects: 0, sessions: 13_000, panes: 0 } });
  assert.deepEqual(bounded.omitted, { projects: 0, sessions: 13_000, panes: 0 });
});

test('the hub schema accepts the omitted marker, requires exact keys, and still parses snapshots without it', () => {
  const body = { epoch: 'epoch-1', revision: 1, ...material() };
  assert.equal(parseFleetCatalogSnapshot(body).omitted, undefined);
  assert.deepEqual(parseFleetCatalogSnapshot({ ...body, omitted: { projects: 0, sessions: 13_000, panes: 1 } }).omitted, { projects: 0, sessions: 13_000, panes: 1 });
  assert.throws(() => parseFleetCatalogSnapshot({ ...body, omitted: { projects: -1, sessions: 0, panes: 0 } }), FleetCatalogParseError);
  assert.throws(() => parseFleetCatalogSnapshot({ ...body, omitted: { sessions: 1 } }), FleetCatalogParseError);
  assert.throws(() => parseFleetCatalogSnapshot({ ...body, omitted: { projects: 0, sessions: 0, panes: 0, extra: 1 } }), FleetCatalogParseError);
});
