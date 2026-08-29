import assert from 'node:assert/strict';
import test from 'node:test';

import { createElement } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import TestRenderer, { act } from 'react-test-renderer';

import FleetSessionRoute from '../../../fleet/FleetSessionRoute';
import { LOCAL_SESSION_ROUTE, REMOTE_SESSION_ROUTE } from '../../../fleet/sessionRoute';
import { adoptLocalHostIdentity } from '../../../fleet/useFleetIdentity';
import type { Project } from '../../../types/app';

import { useSlashCommandCatalog } from './useSlashCommandCatalog';
import type { SlashCommand } from './slashCommandCatalog';

const LOCAL = '11111111-1111-4111-8111-111111111111';
const PEER_A = '22222222-2222-4222-8222-222222222222';
const SESSION = 'session-collision';

const PROJECT: Project = {
  projectId: 'project-collision',
  displayName: 'collision',
  fullPath: '/private/local',
};

type Requested = { readonly url: string; readonly method: string };

function stubFetch(answers: Readonly<Record<string, unknown>>) {
  const original = globalThis.fetch;
  const requests: Requested[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, method: init?.method ?? 'GET' });
    const key = Object.keys(answers).find((candidate) => url.startsWith(candidate));
    if (key === undefined) {
      return { ok: false, status: 404, headers: { get: () => null }, json: async () => ({}) } as unknown as Response;
    }
    return {
      ok: true, status: 200, headers: { get: () => 'application/json' },
      json: async () => answers[key],
    } as unknown as Response;
  }) as typeof fetch;
  return { requests, restore: () => { globalThis.fetch = original; } };
}

async function mount(hostId: string | null, answers: Readonly<Record<string, unknown>>) {
  const fetches = stubFetch(answers);
  adoptLocalHostIdentity(LOCAL);
  let commands: SlashCommand[] = [];
  function Probe() {
    commands = useSlashCommandCatalog(PROJECT, 'gjc');
    return null;
  }
  const path = hostId === null || hostId === LOCAL
    ? `/session/${SESSION}`
    : `/hosts/${hostId}/session/${SESSION}`;
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  await act(async () => {
    renderer = TestRenderer.create(createElement(
      MemoryRouter,
      { initialEntries: [path] },
      createElement(
        Routes,
        null,
        createElement(Route, {
          path: LOCAL_SESSION_ROUTE,
          element: createElement(FleetSessionRoute, null, createElement(Probe)),
        }),
        createElement(Route, {
          path: REMOTE_SESSION_ROUTE,
          element: createElement(FleetSessionRoute, null, createElement(Probe)),
        }),
      ),
    ));
  });
  const active = renderer;
  assert.ok(active);
  return {
    commands: () => commands,
    requests: () => fetches.requests,
    dispose: async () => {
      await act(async () => { active.unmount(); });
      fetches.restore();
    },
  };
}

test('Given a session owned by a peer, when the catalog loads, then it comes from that host and no controller inventory is read', async (t) => {
  // Given
  const harness = await mount(PEER_A, {
    [`/api/hosts/${PEER_A}/providers/sessions/${SESSION}/inventory`]: {
      data: { provider: 'gjc', commands: [{ name: 'peer-a-skill', description: 'peer only', scope: 'project' }] },
    },
  });
  t.after(harness.dispose);

  // Then
  assert.deepEqual(harness.commands().map((command) => command.name), ['/peer-a-skill']);
  assert.deepEqual(
    harness.requests().filter((request) => request.url.includes('/inventory')).map((request) => request.url),
    [`/api/hosts/${PEER_A}/providers/sessions/${SESSION}/inventory`],
  );
  assert.equal(harness.requests().some((request) => request.url.startsWith('/api/commands/list')), false);
  assert.equal(harness.requests().some((request) => request.url.includes('/skills')), false);
});

test('Given a local session, when the catalog loads, then the existing controller endpoints answer unchanged', async (t) => {
  // Given
  const harness = await mount(LOCAL, {
    '/api/commands/list': { builtIn: [{ name: '/local-builtin' }], custom: [{ name: '/local-custom' }] },
    '/api/providers/gjc/skills': { success: true, data: { skills: [{ name: 'local', command: '/local-skill', scope: 'project' }] } },
  });
  t.after(harness.dispose);

  // Then
  assert.deepEqual(
    harness.commands().map((command) => command.name).sort(),
    ['/local-builtin', '/local-custom', '/local-skill'],
  );
  assert.equal(harness.requests().some((request) => request.url.includes('/api/hosts/')), false);
});

test('Given a peer whose inventory is unreadable, when the catalog loads, then no command is offered instead of the hub\u2019s', async (t) => {
  // Given
  const harness = await mount(PEER_A, {
    '/api/commands/list': { builtIn: [{ name: '/controller-builtin' }], custom: [] },
  });
  t.after(harness.dispose);

  // Then
  assert.deepEqual(harness.commands(), []);
  assert.equal(harness.requests().some((request) => request.url.startsWith('/api/commands/list')), false);
});
