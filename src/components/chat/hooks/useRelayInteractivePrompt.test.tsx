import assert from 'node:assert/strict';
import test from 'node:test';

import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';

import { useRelayInteractivePrompt, type RelayInteractivePromptInput } from './useRelayInteractivePrompt';

test('a prompt cannot survive a pane generation change or a failed read', async () => {
  const original = globalThis.fetch;
  const replies: Array<(response: Response) => void> = [];
  globalThis.fetch = (() => new Promise<Response>((resolve) => { replies.push(resolve); })) as typeof fetch;
  const input: RelayInteractivePromptInput = {
    relayKind: 'codex', target: { tmux: { socketPath: '/tmp/test.sock', sessionId: '$1', windowId: '@1', paneId: '%1' }, process: { pid: 42, startedAtMs: 1 } },
    session: { hostId: null, localHostId: null, localId: 'same-session' },
  };
  const visible: Array<string | null> = [];
  function Probe(props: RelayInteractivePromptInput) {
    const { prompt } = useRelayInteractivePrompt(props);
    visible.push(prompt?.id ?? null);
    return null;
  }
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  try {
    await act(async () => { renderer = TestRenderer.create(createElement(Probe, input)); });
    await act(async () => { replies[0]?.(Response.json({ data: { prompt: { id: 'old-prompt', question: 'Continue?', options: [{ label: 'Yes' }] } } })); });
    assert.equal(visible.at(-1), 'old-prompt');
    visible.length = 0;
    await act(async () => { renderer?.update(createElement(Probe, { ...input, target: { ...input.target, process: { pid: 42, startedAtMs: 2 } } })); });
    assert.ok(visible.every((prompt) => prompt === null));
    await act(async () => { replies[1]?.(new Response(null, { status: 503 })); });
    assert.equal(visible.at(-1), null);
  } finally {
    await act(async () => { renderer?.unmount(); });
    globalThis.fetch = original;
  }
});
