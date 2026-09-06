import assert from 'node:assert/strict';
import test from 'node:test';

import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';

import { useGitActions } from './useGitActions';

test('Git callbacks cannot act after selection changes, returns to the same id, or unmounts', async (t) => {
  const requests: unknown[] = [];
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, options?: RequestInit) => {
    requests.push([String(input), JSON.parse(String(options?.body))]);
    return Response.json({ success: true });
  });
  let actions!: ReturnType<typeof useGitActions>;
  function Surface({ id }: { id?: string }) { actions = useGitActions(id); return null; }
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(createElement(Surface, { id: 'same-project' })); });
  const old = actions;
  await act(async () => { await actions.fetch(); });
  assert.deepEqual(requests, [['/api/git/fetch', { project: 'same-project' }]]);
  requests.length = 0;
  await act(async () => { renderer.update(createElement(Surface)); });
  await act(async () => { await old.pull(); await actions.push(); });
  await act(async () => { renderer.update(createElement(Surface, { id: 'same-project' })); });
  await act(async () => { await old.checkout('main'); });
  await act(async () => { renderer.unmount(); });
  await actions.push();
  assert.deepEqual(requests, []);
});
