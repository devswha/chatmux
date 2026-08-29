import assert from 'node:assert/strict';
import test from 'node:test';

import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';

import { setLocalHostIdentity, clearHostIdentity } from '../../../fleet/hostIdentity';
import type { Project } from '../../../types/app';

import { useSessionMessageSearch, type SessionMessageMatch } from './useSessionMessageSearch';

const LOCAL = '11111111-1111-4111-8111-111111111111';
const PEER_A = '22222222-2222-4222-8222-222222222222';
const PEER_B = '33333333-3333-4333-8333-333333333333';
const PROJECT = 'project-collision';

const project = (hostId?: string): Project => ({
  projectId: PROJECT,
  name: PROJECT,
  displayName: 'collision',
  path: '/collision',
  fullPath: '/collision',
  sessions: [],
  ...(hostId === undefined ? {} : { hostId }),
});

const peerBody = (host: string) => ({
  data: {
    query: 'needle',
    results: [
      {
        projectId: PROJECT,
        projectName: 'collision',
        sessions: [{ sessionId: `session-${host}`, provider: 'codex', sessionSummary: `${host} summary`, matches: [{ snippet: `${host} snippet` }] }],
      },
      {
        projectId: 'other-project',
        projectName: 'other',
        sessions: [{ sessionId: 'other-session', provider: 'codex', sessionSummary: 'other', matches: [{ snippet: 'x' }] }],
      },
    ],
  },
});

type Harness = {
  readonly matches: () => readonly SessionMessageMatch[];
  readonly dispose: () => void;
};

function mount(target: Project): Harness {
  let latest: readonly SessionMessageMatch[] = [];
  function Surface({ value }: { value: Project }) {
    latest = useSessionMessageSearch({ project: value, query: 'needle', enabled: true });
    return null;
  }
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  act(() => { renderer = TestRenderer.create(createElement(Surface, { value: target })); });
  const active = renderer;
  assert.ok(active);
  return { matches: () => latest, dispose: () => act(() => { active.unmount(); }) };
}

type Probe = {
  readonly fetched: readonly string[];
  readonly eventSources: readonly string[];
  readonly restore: () => void;
};

function probe(bodyFor: (url: string) => unknown): Probe {
  const originalFetch = globalThis.fetch;
  const originalEventSource = Reflect.get(globalThis, 'EventSource');
  const fetched: string[] = [];
  const eventSources: string[] = [];
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    fetched.push(url);
    return Promise.resolve(new Response(JSON.stringify(bodyFor(url)), { status: 200 }));
  }) as typeof globalThis.fetch;
  Reflect.set(globalThis, 'EventSource', class {
    constructor(url: string) { eventSources.push(url); }
    addEventListener(): void { /* the local stream is not driven in this suite */ }
    close(): void { /* nothing to release */ }
  });
  return {
    fetched,
    eventSources,
    restore: () => {
      globalThis.fetch = originalFetch;
      Reflect.set(globalThis, 'EventSource', originalEventSource);
    },
  };
}

test('Given a local project, when a transcript search runs, then the existing streaming endpoint is used', async (t) => {
  // Given
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const probes = probe(() => ({}));
  t.after(probes.restore);
  setLocalHostIdentity(LOCAL);
  t.after(clearHostIdentity);
  const harness = mount(project(LOCAL));
  t.after(harness.dispose);

  // When
  await act(async () => { t.mock.timers.tick(400); await Promise.resolve(); });

  // Then
  assert.deepEqual(probes.eventSources, ['/api/providers/search/sessions?q=needle&limit=50']);
  assert.deepEqual(probes.fetched, []);
});

test('Given the same project id on two peers, when a transcript search runs, then each host answers its own transcripts', async (t) => {
  // Given
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const probes = probe((url) => peerBody(url.includes(PEER_A) ? PEER_A : PEER_B));
  t.after(probes.restore);
  setLocalHostIdentity(LOCAL);
  t.after(clearHostIdentity);
  const onA = mount(project(PEER_A));
  t.after(onA.dispose);
  const onB = mount(project(PEER_B));
  t.after(onB.dispose);

  // When
  await act(async () => { t.mock.timers.tick(400); await Promise.resolve(); });
  await act(async () => { await Promise.resolve(); });

  // Then
  assert.deepEqual(probes.eventSources, []);
  assert.deepEqual(probes.fetched, [
    `/api/hosts/${PEER_A}/projects/${PROJECT}/search?query=needle&limit=50`,
    `/api/hosts/${PEER_B}/projects/${PROJECT}/search?query=needle&limit=50`,
  ]);
  assert.deepEqual(onA.matches(), [{ sessionId: `session-${PEER_A}`, label: `${PEER_A} summary`, snippet: `${PEER_A} snippet`, provider: 'codex' }]);
  assert.deepEqual(onB.matches(), [{ sessionId: `session-${PEER_B}`, label: `${PEER_B} summary`, snippet: `${PEER_B} snippet`, provider: 'codex' }]);
});

test('Given a peer project, when the search is disabled or too short, then no host is queried', async (t) => {
  // Given
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const probes = probe(() => peerBody(PEER_A));
  t.after(probes.restore);
  setLocalHostIdentity(LOCAL);
  t.after(clearHostIdentity);
  let latest: readonly SessionMessageMatch[] = [];
  function Surface({ query, enabled }: { query: string; enabled: boolean }) {
    latest = useSessionMessageSearch({ project: project(PEER_A), query, enabled });
    return null;
  }
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  act(() => { renderer = TestRenderer.create(createElement(Surface, { query: 'n', enabled: true })); });
  const active = renderer;
  assert.ok(active);
  t.after(() => act(() => { active.unmount(); }));

  // When
  await act(async () => { t.mock.timers.tick(400); await Promise.resolve(); });
  act(() => { active.update(createElement(Surface, { query: 'needle', enabled: false })); });
  await act(async () => { t.mock.timers.tick(400); await Promise.resolve(); });

  // Then
  assert.deepEqual(probes.fetched, []);
  assert.deepEqual(latest, []);
});
