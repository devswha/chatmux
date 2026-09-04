import assert from 'node:assert/strict';
import test from 'node:test';

import { dispatchRelay, interruptRelay, relayTargetKey } from './relayTransport';

const HOST = '22222222-2222-4222-8222-222222222222';
const target = {
  hostId: HOST, localId: 'collision-pane', lane: 'external' as const,
  tmux: { socketPath: '/tmp/peer.sock', sessionId: '$1', windowId: '@1', paneId: '%1' },
  process: { pid: 41, startedAtMs: 8_000 },
};

test('relay state keys distinguish hosts, sockets, panes, and processes even at equal start times', () => {
  const original = relayTargetKey('codex', target);
  for (const next of [
    { ...target, hostId: '33333333-3333-4333-8333-333333333333' },
    { ...target, tmux: { ...target.tmux, socketPath: '/tmp/other.sock' } },
    { ...target, tmux: { ...target.tmux, sessionId: '$2' } },
    { ...target, tmux: { ...target.tmux, windowId: '@2' } },
    { ...target, process: { ...target.process, pid: 42 } },
  ]) assert.notEqual(relayTargetKey('codex', next), original);
  assert.equal(relayTargetKey('codex', { ...target, process: { ...target.process } }), original);
});

test('Given a remote relay, when text, prompt, and interrupt are sent, then every request remains host qualified', async (t) => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ readonly url: string; readonly body: unknown }> = [];
  globalThis.fetch = async (input, init) => {
    requests.push({
      url: String(input),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
    });
    return new Response(JSON.stringify({ data: { ok: true } }), { status: 200 });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const input = {
    relayKind: 'codex', target, transcriptSessionId: 'collision-session',
    promptId: '0123456789abcdef0123456789abcdef', askToolId: '',
  };

  await dispatchRelay(input, { kind: 'text' }, 'alpha');
  await dispatchRelay(input, { kind: 'interactive-choices', choices: [1] }, '1');
  await interruptRelay(input);

  assert.deepEqual(requests.map((request) => request.url), [
    `/api/hosts/${HOST}/providers/panes/collision-pane/actions`,
    `/api/hosts/${HOST}/providers/sessions/collision-session/prompt/respond`,
    `/api/hosts/${HOST}/providers/panes/collision-pane/actions`,
  ]);
  assert.deepEqual(requests.map((request) => request.body), [
    { lane: 'external', tmux: target.tmux, process: target.process, action: 'send', message: 'alpha' },
    { response: 'choices', promptId: input.promptId, choices: [1] },
    { lane: 'external', tmux: target.tmux, process: target.process, action: 'interrupt' },
  ]);
});

test('Given a fresh remote pane without a transcript, text still uses its host-qualified pane action', async (t) => {
  const originalFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = async (input) => {
    urls.push(String(input));
    return new Response(JSON.stringify({ data: { ok: true } }), { status: 200 });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const response = await dispatchRelay({
    relayKind: 'codex', target, transcriptSessionId: null, promptId: '', askToolId: '',
  }, { kind: 'text' }, 'before-transcript');

  assert.equal(response.ok, true);
  assert.deepEqual(urls, [`/api/hosts/${HOST}/providers/panes/collision-pane/actions`]);
});
