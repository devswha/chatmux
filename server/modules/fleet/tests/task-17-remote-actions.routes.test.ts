import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COLLIDING_SESSION, PEER_A, PEER_B, closeFixture, startRoutesFixture,
} from './support/task-16-routes-fixture.js';

const pane = {
  lane: 'external',
  tmux: { socketPath: '/tmp/collision.sock', sessionId: '$1', windowId: '@1', paneId: '%1' },
  process: { pid: 41, startedAtMs: 8_000 },
};

async function post(baseUrl: string, path: string, body: object): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}

test('Given colliding panes on two peers, when every pane action is posted, then only the addressed host is mutated with distinct semantics', async (t) => {
  const fixture = await startRoutesFixture();
  t.after(() => closeFixture(fixture.server));

  for (const action of ['send', 'interrupt', 'escape', 'terminate-process', 'terminate-pane', 'terminate-session'] as const) {
    const response = await post(fixture.baseUrl, `/hosts/${PEER_A}/providers/panes/collision-pane/actions`, {
      ...pane, action, ...(action === 'send' ? { message: 'alpha' } : {}),
    });
    assert.equal(response.status, 200, action);
  }

  assert.deepEqual(
    fixture.calls.slice(-6).map((call) => [call.hostId, call.method, call.localId]),
    [
      [PEER_A, 'sendPane', 'collision-pane'],
      [PEER_A, 'interrupt', 'collision-pane'],
      [PEER_A, 'escape', 'collision-pane'],
      [PEER_A, 'terminateProcess', 'collision-pane'],
      [PEER_A, 'terminatePane', 'collision-pane'],
      [PEER_A, 'terminateSession', 'collision-pane'],
    ],
  );
  assert.equal(fixture.calls.some((call) => call.hostId === PEER_B), false);
});

test('Given a remote native prompt and approval, when the owner responds, then each response keeps its session and host', async (t) => {
  const fixture = await startRoutesFixture();
  t.after(() => closeFixture(fixture.server));

  const prompt = await post(fixture.baseUrl, `/hosts/${PEER_B}/providers/sessions/${COLLIDING_SESSION}/prompt/respond`, {
    response: 'choices', promptId: '0123456789abcdef0123456789abcdef', choices: [1],
  });
  const approval = await post(fixture.baseUrl, `/hosts/${PEER_B}/providers/sessions/${COLLIDING_SESSION}/approval/respond`, {
    decision: 'approve-once',
  });

  assert.equal(prompt.status, 200);
  assert.equal(approval.status, 200);
  assert.deepEqual(fixture.calls.slice(-2).map((call) => [call.hostId, call.method]), [
    [PEER_B, 'respondPrompt'], [PEER_B, 'respondApproval'],
  ]);
});

test('Given an offline peer, when a destructive action is requested, then admission fails before mutation', async (t) => {
  const fixture = await startRoutesFixture();
  t.after(() => closeFixture(fixture.server));
  const status = fixture.statuses.get(PEER_A);
  assert.ok(status);
  fixture.statuses.set(PEER_A, { ...status, state: 'offline' });

  const response = await post(fixture.baseUrl, `/hosts/${PEER_A}/providers/panes/collision-pane/actions`, {
    ...pane, action: 'terminate-session',
  });

  assert.equal(response.status, 503);
  assert.equal(fixture.calls.length, 0);
});
