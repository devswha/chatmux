import assert from 'node:assert/strict';
import test from 'node:test';

import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';

import type { Project } from '../../../types/app';

import { useLocalTokenUsage } from './useLocalTokenUsage';

const local: Project = { projectId: 'same/project', displayName: 'Project', fullPath: '/same/path' };
const peer = { ...local, hostId: '22222222-2222-4222-8222-222222222222' };

test('peer history usage survives a delayed hub token response and peer selection makes no local request', async (t) => {
  let resolve!: (usage: Record<string, unknown>) => void;
  const pending = new Promise<Record<string, unknown>>((done) => { resolve = done; });
  const requests: string[] = [];
  let signal: AbortSignal | undefined;
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, options?: RequestInit) => {
    requests.push(String(input)); signal = options?.signal ?? undefined;
    return { ok: true, json: () => pending } as Response;
  });
  const updates: unknown[] = [];
  const setUsage = (value: unknown) => updates.push(value);
  function Surface({ project }: { project: Project }) {
    useLocalTokenUsage(project, 'same/session', setUsage);
    return null;
  }
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(createElement(Surface, { project: local })); });
  t.after(() => act(() => renderer.unmount()));
  await act(async () => { renderer.update(createElement(Surface, { project: peer })); });
  await act(async () => { resolve({ source: 'hub' }); });
  assert.equal(signal?.aborted, true);
  assert.deepEqual(requests, ['/api/projects/same%2Fproject/sessions/same%2Fsession/token-usage']);
  assert.deepEqual(updates, []);
});

test('local token usage handles success, HTTP failure, and network failure', async (t) => {
  let mode = 'success';
  t.mock.method(globalThis, 'fetch', async () => {
    if (mode === 'network') throw new Error('fixture failure');
    return mode === 'success' ? Response.json({ tokens: 12 }) : new Response(null, { status: 503 });
  });
  const updates: unknown[] = [];
  const setUsage = (value: unknown) => updates.push(value);
  function Surface({ session }: { session: string }) {
    useLocalTokenUsage(local, session, setUsage);
    return null;
  }
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(createElement(Surface, { session: mode })); });
  t.after(() => act(() => renderer.unmount()));
  for (mode of ['http', 'network']) {
    await act(async () => { renderer.update(createElement(Surface, { session: mode })); });
  }
  assert.deepEqual(updates, [{ tokens: 12 }, null, null]);
});
