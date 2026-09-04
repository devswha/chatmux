import assert from 'node:assert/strict';
import test from 'node:test';

import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';

import { useRelayCommandInventory, type RelayCommandInventoryInput } from './useRelayCommandInventory';

test('a provider/workspace switch clears the prior inventory before the new request succeeds', async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; resolve: (response: Response) => void }> = [];
  globalThis.fetch = ((url: string | URL | Request) => new Promise<Response>((resolve) => {
    requests.push({ url: String(url), resolve });
  })) as typeof fetch;
  const observed: string[][] = [];
  const input: RelayCommandInventoryInput = {
    relayKind: 'omo', workspacePath: '/workspace/a', commandTrigger: '/',
    session: { hostId: null, localHostId: null, localId: 'same-id' },
  };
  function Probe(props: RelayCommandInventoryInput) {
    const commands = useRelayCommandInventory(props);
    observed.push(commands.map((command) => command.name));
    return createElement('output', null, commands.map((command) => command.name).join(','));
  }
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  try {
    await act(async () => { renderer = TestRenderer.create(createElement(Probe, input)); });
    await act(async () => { requests[0]?.resolve(Response.json({ skills: [{ name: 'omo-only', command: '/omo-only' }] })); });
    assert.deepEqual(observed.at(-1), ['/omo-only']);

    observed.length = 0;
    await act(async () => {
      renderer?.update(createElement(Probe, { ...input, relayKind: 'codex', commandTrigger: '$', workspacePath: '/workspace/b' }));
    });
    assert.ok(observed.length > 0);
    assert.ok(observed.every((commands) => commands.length === 0), 'no render may expose the old provider catalog while loading');
    await act(async () => { requests[1]?.resolve(new Response(null, { status: 500 })); });
    assert.deepEqual(observed.at(-1), [], 'a failed lookup must not restore the previous catalog');
  } finally {
    await act(async () => { renderer?.unmount(); });
    globalThis.fetch = originalFetch;
  }
});
