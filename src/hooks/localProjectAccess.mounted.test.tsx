import assert from 'node:assert/strict';
import test from 'node:test';

import { createElement, createRef } from 'react';
import TestRenderer, { act } from 'react-test-renderer';

import { useFileMentions } from '../components/chat/hooks/useFileMentions';
import type { Project } from '../types/app';

import { useFileOpenResolver } from './useFileOpenResolver';

const PEER = '22222222-2222-4222-8222-222222222222';
const project = (hostId?: string): Project => ({ projectId: 'collision', displayName: 'Project', fullPath: '/same/path', ...(hostId ? { hostId } : {}) });

test('peer file mentions and file links never read or open the hub project with the same id', async (t) => {
  const requests: string[] = [];
  const opened: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
    requests.push(String(input));
    return Response.json([{ type: 'file', name: 'hub.txt', path: 'hub.txt' }]);
  });
  let mentions!: ReturnType<typeof useFileMentions>;
  let open!: ReturnType<typeof useFileOpenResolver>;
  function Surface() {
    mentions = useFileMentions({ selectedProject: project(PEER), input: '', setInput: () => {}, textareaRef: createRef() });
    open = useFileOpenResolver(project(PEER), (file) => opened.push(file));
    return null;
  }
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(createElement(Surface)); });
  t.after(() => act(() => renderer.unmount()));
  await act(async () => { open('hub.txt'); });
  assert.deepEqual(requests, []);
  assert.deepEqual(opened, []);
  assert.deepEqual(mentions.filteredFiles, []);
});

test('a late local file lookup cannot open the editor after switching to a peer', async (t) => {
  let resolve!: (response: Response) => void;
  const pending = { promise: new Promise<Response>((done) => { resolve = done; }) };
  t.mock.method(globalThis, 'fetch', () => pending.promise);
  const opened: string[] = [];
  let open!: ReturnType<typeof useFileOpenResolver>;
  function Surface({ value }: { value: Project }) {
    open = useFileOpenResolver(value, (file) => opened.push(file));
    return null;
  }
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(createElement(Surface, { value: project() })); });
  t.after(() => act(() => renderer.unmount()));
  const oldOpen = open;
  await act(async () => { open('hub.txt'); });
  await act(async () => { renderer.update(createElement(Surface, { value: project(PEER) })); });
  await act(async () => {
    resolve(Response.json([{ type: 'file', name: 'hub.txt', path: 'hub/hub.txt' }]));
  });
  await act(async () => { oldOpen('hub.txt'); });
  assert.deepEqual(opened, []);
});

test('local file links still resolve basenames and preserve diff details', async (t) => {
  const requests: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
    requests.push(String(input));
    return Response.json([{ type: 'file', name: 'file.ts', path: 'src/file.ts' }]);
  });
  const opened: unknown[][] = [];
  let open!: ReturnType<typeof useFileOpenResolver>;
  function Surface() {
    open = useFileOpenResolver(project(), (...args) => opened.push(args));
    return null;
  }
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(createElement(Surface)); });
  t.after(() => act(() => renderer.unmount()));
  await act(async () => { open('file.ts', { before: 'old' }); });
  assert.deepEqual(requests, ['/api/projects/collision/files']);
  assert.deepEqual(opened, [['src/file.ts', { before: 'old' }]]);
});
