import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { paneSubscriptionKey } from '../../../../shared/tmux';

import { buildExternalAttachTarget, buildTranscriptCliAttachTarget, paneStreamFallbackNeeded, paneStreamFrame, shouldShowPendingRelay } from './MainContent';

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

const tmux = { socketPath: 'socket', sessionId: '$1', windowId: '@1', paneId: '%1' };
const project = { projectId: 'project-1', displayName: 'Project', fullPath: '/workspace/project' };

test('M5b B8: forceAttach skips the pending relay surface for a local-agent pane with an observable process', () => {
  const withoutForce = {
    tmuxName: 'claude-review',
    tmux,
    process: { pid: 1, startedAtMs: 1 },
    kind: 'Claude Code',
    cliKind: 'claude' as const,
    project,
  };
  assert.equal(shouldShowPendingRelay(withoutForce), true);
  assert.equal(shouldShowPendingRelay({ ...withoutForce, forceAttach: true }), false);
  assert.equal(shouldShowPendingRelay(null), false);
});

test('M5b B8: forced attach resolves to the exact pane 4-tuple as a local-agent shell target, never another pane', () => {
  const process = { pid: 7, startedAtMs: 123 };
  const target = {
    tmuxName: 'claude-review',
    tmux,
    process,
    kind: 'Claude Code',
    cliKind: 'claude' as const,
    project,
    forceAttach: true,
  };
  const attachTarget = buildExternalAttachTarget(target);
  assert.deepEqual(attachTarget, { targetClass: 'local-agent', tmux, process });

  const otherPane = { ...target, tmux: { ...tmux, paneId: '%9' } };
  const otherAttachTarget = buildExternalAttachTarget(otherPane);
  assert.notDeepEqual(otherAttachTarget?.tmux, attachTarget?.tmux);
});

test('M5b B8 AC3: a ssh/shell row without an issued attachCapability never attaches, regardless of forceAttach', () => {
  const sshTarget = {
    tmuxName: 'remote',
    tmux,
    process: null,
    kind: 'ssh',
    cliKind: 'ssh' as const,
    project,
  };
  assert.equal(buildExternalAttachTarget(sshTarget), null);
  assert.equal(buildExternalAttachTarget({ ...sshTarget, forceAttach: true }), null);

  const withCapability = { ...sshTarget, attachCapability: 'token-123' };
  assert.deepEqual(buildExternalAttachTarget(withCapability), {
    targetClass: 'attach-only', tmux, capability: 'token-123',
  });
});

test('CLI output tab upgrades to an exact-4-tuple interactive attach only with a process identity', () => {
  const tmuxTarget = { socketPath: 'socket', sessionId: '$3', windowId: '@3', paneId: '%3' };
  const process = { pid: 11, startedAtMs: 456 };

  // With an observable process generation the tab attaches to exactly that pane.
  assert.deepEqual(
    buildTranscriptCliAttachTarget({ tmux: tmuxTarget, process }),
    { targetClass: 'local-agent', tmux: tmuxTarget, process },
  );

  // Without a process identity the tab must stay read-only: attaching by
  // tmux name alone could type into an unrelated pane.
  assert.equal(buildTranscriptCliAttachTarget({ tmux: tmuxTarget, process: null }), null);
  assert.equal(buildTranscriptCliAttachTarget({ tmux: tmuxTarget }), null);
  assert.equal(buildTranscriptCliAttachTarget(null), null);
});

test('pending CLI output hides the duplicate chat composer while terminal input is active', async () => {
  const source = await readFile(new URL('./MainContent.tsx', import.meta.url), 'utf8');
  const branchStart = source.indexOf('&& shouldShowPendingRelay(externalTerminal)');
  const branchEnd = source.indexOf('// Targets without a locally observable process remain terminal-only.');
  assert.notEqual(branchStart, -1);
  assert.ok(branchEnd > branchStart);

  const pendingBranch = source.slice(branchStart, branchEnd);
  assert.match(
    pendingBranch,
    /\{externalTranscriptView === 'conversation' && \(\s*<LiveRelayComposer/,
  );
  assert.match(
    pendingBranch,
    /projectPath=\{'projectPath' in externalTerminal \? externalTerminal\.projectPath : undefined\}/,
    'the pending CLI shell wiring forwards the external-only workspace path',
  );
});
