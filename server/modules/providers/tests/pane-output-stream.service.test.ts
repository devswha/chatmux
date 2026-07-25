import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { createVerifiedTmuxActionTarget } from '@/modules/providers/index.js';

import type { DiscoverySnapshot } from '../services/discovery-collector.service.js';
import { PANE_OUTPUT_MAX_BUFFERED_BYTES, PANE_REMINT_MS, createPaneOutputStream } from '../services/pane-output-stream.service.js';

class FakeWebSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  bufferedAmount = 0;
  readonly sent: string[] = [];
  send(message: string, callback?: () => void): void { this.sent.push(message); callback?.(); }
}

const tmux = { socketPath: '/tmp/tmux', sessionId: '$1', windowId: '@1', paneId: '%1' };
const process = { pid: 42, startedAtMs: 100 };
const target = createVerifiedTmuxActionTarget(tmux, process, 'claude', 'agent');
const data = { protocolVersion: 1, lane: 'external', tmux, process };

function events(ws: FakeWebSocket): Record<string, unknown>[] { return ws.sent.map((frame) => JSON.parse(frame) as Record<string, unknown>); }
function matchingSnapshot(): DiscoverySnapshot {
  return {
    epoch: 'e', revision: 1, takenAtMs: 1, rows: [{ key: 'external\0/tmp/tmux\0$1\0@1\0%1', lane: 'external', tmuxName: 'x', tmux, process, kind: 'claude', providerSessionId: null, activity: 'running', cwd: null, lastSeenRevision: 1, presence: 'present', staleSinceRevision: null }],
    health: { external: { ok: true, lastOkRevision: 1, consecutiveFailures: 0 }, live: { ok: true, lastOkRevision: 1, consecutiveFailures: 0 } },
  };
}

function fixture(overrides: Parameters<typeof createPaneOutputStream>[0] = {}) {
  let tick: (() => void) | undefined;
  const stream = createPaneOutputStream({
    now: () => 0, mint: async () => target, assertIdentity: async () => undefined, capturePane: async () => 'output', normalizeOutput: (value) => value,
    setTimer: (callback) => { tick = callback; return 1 as never; }, clearTimer: () => undefined,
    ...overrides,
  });
  return { stream, tick: async () => { tick?.(); await new Promise((resolve) => setImmediate(resolve)); } };
}

test('P1 rejects failed verification without creating a capture subscription', async () => {
  const ws = new FakeWebSocket(); const { stream, tick } = fixture({ mint: async () => { throw new Error('no'); } });
  stream.start(); await stream.subscribe(ws as never, data);
  assert.deepEqual(events(ws).map((event) => [event.kind, event.reason]), [['pane.invalidated', 'unauthorized']]);
  await tick(); assert.equal(ws.sent.length, 1);
  stream.dispose();
});

test('P2 remints before capture and discards expired targets when remint fails', async () => {
  let now = 0; let mints = 0; let captures = 0; const ws = new FakeWebSocket();
  const { stream, tick } = fixture({ now: () => now, mint: async () => { mints += 1; if (mints === 3) throw new Error('expired'); return target; }, capturePane: async () => { captures += 1; return String(captures); } });
  stream.start(); await stream.subscribe(ws as never, data); now = PANE_REMINT_MS; await tick();
  assert.equal(mints, 2); assert.equal(captures, 2);
  now += PANE_REMINT_MS; await tick();
  assert.equal(captures, 2, 'expired target was never captured after failed remint');
  assert.equal(events(ws).at(-1)?.reason, 'remint_failed');
  stream.dispose();
});

test('P3 identity recheck invalidates and P4 snapshots revoke but never extend a subscription', async () => {
  let now = 0; let identityOK = true; let mints = 0; const ws = new FakeWebSocket();
  const { stream, tick } = fixture({ now: () => now, mint: async () => { mints += 1; if (mints === 3) throw new Error('must remint'); return target; }, assertIdentity: async () => { if (!identityOK) throw new Error('changed'); } });
  stream.start(); await stream.subscribe(ws as never, data); identityOK = false; await tick();
  assert.equal(events(ws).at(-1)?.reason, 'pane_identity_changed');
  const second = new FakeWebSocket(); identityOK = true; await stream.subscribe(second as never, data); now = PANE_REMINT_MS;
  stream.reconcile(matchingSnapshot()); await tick();
  assert.equal(mints, 3, 'matching snapshot did not approve or extend the expired subscription');
  assert.equal(events(second).at(-1)?.reason, 'remint_failed');
  stream.dispose();
});

test('unsubscribe and closed connections stop later capture cycles', async () => {
  let captures = 0; const ws = new FakeWebSocket(); const { stream, tick } = fixture({ capturePane: async () => { captures += 1; return 'output'; } });
  stream.start(); await stream.subscribe(ws as never, data);
  const id = events(ws)[0]?.subscriptionId as string; stream.unsubscribe(ws as never, id); await tick();
  assert.equal(captures, 1);
  const second = new FakeWebSocket(); await stream.subscribe(second as never, data); stream.close(second as never); await tick();
  assert.equal(captures, 2);
  stream.dispose();
});
test('duplicate subscriptions invalidate the prior id before attaching the replacement', async () => {
  let mints = 0; let captures = 0;
  const ws = new FakeWebSocket();
  ws.bufferedAmount = PANE_OUTPUT_MAX_BUFFERED_BYTES + 1;
  const { stream } = fixture({
    mint: async () => { mints += 1; return target; },
    capturePane: async () => { captures += 1; return 'output'; },
  });

  await stream.subscribe(ws as never, data);
  await stream.subscribe(ws as never, data);
  assert.equal(mints, 1, 'duplicate subscription shares its verified target');
  assert.equal(captures, 1, 'duplicate subscription shares its capture');

  ws.bufferedAmount = 0;
  await new Promise((resolve) => setTimeout(resolve, 60));
  const [invalidated, attached] = events(ws);
  assert.deepEqual([invalidated?.kind, invalidated?.reason], ['pane.invalidated', 'superseded']);
  assert.equal(attached?.kind, 'pane.attached');
  assert.notEqual(attached?.subscriptionId, invalidated?.subscriptionId);
  assert.equal(events(ws).filter((event) => event.subscriptionId === invalidated?.subscriptionId && event.kind !== 'pane.invalidated').length, 0);
  stream.dispose();
});
test('slow sockets retain only the newest pane output while fast fanout continues', async () => {
  let output = 'initial';
  const slow = new FakeWebSocket();
  const fast = new FakeWebSocket();
  slow.bufferedAmount = PANE_OUTPUT_MAX_BUFFERED_BYTES + 1;
  const { stream, tick } = fixture({ capturePane: async () => output });
  stream.start();
  await stream.subscribe(slow as never, data);
  await stream.subscribe(fast as never, data);

  for (let index = 1; index <= 12; index += 1) {
    output = `output-${index}`;
    await tick();
  }

  assert.equal(slow.sent.length, 0, 'buffered socket must not receive unbounded writes');
  assert.equal(events(fast).filter((event) => event.kind === 'pane.output').length, 12);
  slow.bufferedAmount = 0;
  await new Promise((resolve) => setTimeout(resolve, 60));
  const slowEvents = events(slow);
  assert.deepEqual(slowEvents.map((event) => event.kind), ['pane.attached', 'pane.output']);
  assert.equal(slowEvents[1]?.output, 'output-12');
  stream.dispose();
});
