import assert from 'node:assert/strict';
import test from 'node:test';

import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';

import { useRelayFileCatalog } from './useRelayFileCatalog';

test('a remote file mention cannot read a matching workspace from the hub', async () => {
  const originalFetch = globalThis.fetch;
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const requests: string[] = [];
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    setTimeout: (callback: () => void) => { queueMicrotask(callback); return 1; }, clearTimeout: () => undefined,
  } });
  globalThis.fetch = (async (input: string | URL | Request) => {
    requests.push(String(input));
    return Response.json(String(input) === '/api/projects'
      ? [{ projectId: 'hub-project', fullPath: '/same/workspace' }]
      : [{ type: 'file', name: 'hub-only.txt', path: 'hub-only.txt' }]);
  }) as typeof fetch;
  let catalog!: ReturnType<typeof useRelayFileCatalog>;
  function Probe() {
    catalog = useRelayFileCatalog('/same/workspace', {
      hostId: '22222222-2222-4222-8222-222222222222', localHostId: '11111111-1111-4111-8111-111111111111',
    });
    return null;
  }
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  try {
    await act(async () => { renderer = TestRenderer.create(createElement(Probe)); });
    await act(async () => { catalog.request(); });
    assert.deepEqual(requests, []);
    assert.deepEqual(catalog.files, []);
  } finally {
    await act(async () => { renderer?.unmount(); });
    globalThis.fetch = originalFetch;
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow); else Reflect.deleteProperty(globalThis, 'window');
  }
});
