import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { paneSubscriptionKey } from '../../../../shared/tmux';

import { paneStreamFallbackNeeded, paneStreamFrame } from './MainContent';

test('applies attached and output frames for the shared pane subscription key', () => {
  const key = paneSubscriptionKey('external', {
    socketPath: 'socket', sessionId: '$1', windowId: '@1', paneId: '%1',
  }, { pid: 42, startedAtMs: 100 });
  const attached = paneStreamFrame({
    kind: 'pane.attached', key, subscriptionId: 'subscription-1', output: 'initial output',
  }, key, null);
  assert.deepEqual(attached, {
    subscriptionId: 'subscription-1', output: 'initial output', invalidated: false,
  });

  const output = paneStreamFrame({
    kind: 'pane.output', subscriptionId: attached?.subscriptionId, output: 'updated output',
  }, key, attached?.subscriptionId ?? null);
  assert.deepEqual(output, {
    subscriptionId: 'subscription-1', output: 'updated output', invalidated: false,
  });
});
test('keeps an attached pane on stream output without repeated REST fallback reads', async () => {
  const source = await readFile(new URL('./MainContent.tsx', import.meta.url), 'utf8');
  const intervalSource = source.match(/const fallbackTimer = window\.setInterval\(\(\) => \{[\s\S]*?\n {4}\}, 5_000\);/);
  assert.ok(intervalSource, 'MainContent must retain the bounded 5-second pane fallback timer');

  const timer = { callback: null as (() => void) | null };
  let fallbackDelay = 0;
  const windowLike = {
    setInterval(callback: () => void, delay: number): number {
      timer.callback = callback;
      fallbackDelay = delay;
      return 1;
    },
  };
  let restCalls = 0;
  const installFallbackTimer = new Function(
    'window',
    'isConnected',
    'streamSubscribed',
    'loadOutput',
    'paneStreamFallbackNeeded',
    intervalSource[0],
  ) as (
    window: typeof windowLike,
    isConnected: boolean,
    streamSubscribed: boolean,
    loadOutput: () => void,
    fallbackNeeded: typeof paneStreamFallbackNeeded,
  ) => void;

  // This is the mounted effect's exact timer body. A pane.attached frame makes
  // streamSubscribed true; advancing multiple fake 5-second periods must not
  // re-enter the REST output loader.
  installFallbackTimer(windowLike, true, true, () => { restCalls += 1; }, paneStreamFallbackNeeded);
  assert.equal(fallbackDelay, 5_000);
  assert.ok(timer.callback);
  for (let tick = 0; tick < 4; tick += 1) timer.callback();
  assert.equal(restCalls, 0);

  // The same subscribed listener still fans out later pane.output frames.
  const key = paneSubscriptionKey('external', {
    socketPath: 'socket', sessionId: '$1', windowId: '@1', paneId: '%1',
  }, { pid: 42, startedAtMs: 100 });
  const attached = paneStreamFrame({
    kind: 'pane.attached', key, subscriptionId: 'subscription-1', output: 'initial output',
  }, key, null);
  const output = paneStreamFrame({
    kind: 'pane.output', subscriptionId: attached?.subscriptionId, output: 'updated output',
  }, key, attached?.subscriptionId ?? null);
  assert.equal(output?.output, 'updated output');

  installFallbackTimer(windowLike, false, true, () => { restCalls += 1; }, paneStreamFallbackNeeded);
  assert.ok(timer.callback);
  timer.callback();
  assert.equal(restCalls, 1, 'the fallback remains available when the websocket is disconnected');
});
