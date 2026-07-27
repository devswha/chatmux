import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { buildShellInitMessage } from './hooks/useShellConnection';

const tmux = {
  socketPath: '/tmp/tmux-1000/default',
  sessionId: 'work',
  windowId: 'work:1',
  paneId: '%2',
};
const process = { pid: 1234, startedAtMs: 1_700_000_000_000 };

const baseInit = {
  projectPath: '/workspace/chatmux',
  sessionId: 'session-1',
  hasSession: true,
  provider: 'claude',
  cols: 120,
  rows: 40,
  initialCommand: 'npx task-master init',
  isPlainShell: false,
  forceRestart: false,
};

test('typed attach init uses coordinates without an initial command', () => {
  const message = buildShellInitMessage({
    ...baseInit,
    attachTarget: { targetClass: 'local-agent', tmux, process },
  });

  assert.deepEqual(message, {
    type: 'init',
    shellProtocolVersion: 2,
    projectPath: '/workspace/chatmux',
    sessionId: 'session-1',
    hasSession: true,
    provider: 'claude',
    cols: 120,
    rows: 40,
    forceRestart: false,
    mode: 'typed-attach',
    targetClass: 'local-agent',
    tmux,
    process,
  });
  assert.equal('initialCommand' in message, false);
});
test('attach-only init includes its capability without a process or initial command', () => {
  const message = buildShellInitMessage({
    ...baseInit,
    attachTarget: { targetClass: 'attach-only', tmux, capability: 'opaque-capability' },
  });

  assert.deepEqual(message, {
    type: 'init',
    shellProtocolVersion: 2,
    projectPath: '/workspace/chatmux',
    sessionId: 'session-1',
    hasSession: true,
    provider: 'claude',
    cols: 120,
    rows: 40,
    forceRestart: false,
    mode: 'typed-attach',
    targetClass: 'attach-only',
    tmux,
    capability: 'opaque-capability',
  });
  assert.equal('process' in message, false);
  assert.equal('initialCommand' in message, false);
});

test('plain shell init keeps its existing fields and adds the protocol version', () => {
  const message = buildShellInitMessage({ ...baseInit, attachTarget: null });

  assert.deepEqual(message, {
    type: 'init',
    shellProtocolVersion: 2,
    ...baseInit,
    mode: 'plain-shell',
  });
});

test('shell consumers retain their command props and no client tmux command builder remains', () => {
  const mainContent = readFileSync(new URL('../main-content/view/MainContent.tsx', import.meta.url), 'utf8');
  const taskMaster = readFileSync(new URL('../task-master/view/modals/TaskMasterSetupModal.tsx', import.meta.url), 'utf8');
  const providerLogin = readFileSync(new URL('../provider-auth/view/ProviderLoginModal.tsx', import.meta.url), 'utf8');
  const standalone = readFileSync(new URL('../standalone-shell/view/StandaloneShell.tsx', import.meta.url), 'utf8');
  const removedBuilder = ['buildExact', 'TmuxAttachCommand'].join('');
  assert.equal(mainContent.includes(removedBuilder), false);
  assert.match(mainContent, /attachTarget=\{attachTarget\}/);
  assert.match(taskMaster, /initialCommand="npx task-master init"/);
  assert.match(providerLogin, /StandaloneShell project=\{DEFAULT_PROJECT_FOR_EMPTY_SHELL\} command=\{command\}/);
  assert.match(standalone, /initialCommand=\{command\}/);
});
test('external terminal targets do not attach without a server-issued capability', () => {
  const mainContent = readFileSync(new URL('../main-content/view/MainContent.tsx', import.meta.url), 'utf8');

  // The builder is the only path to an attach target, so lock its contract
  // rather than its spelling: attach-only rows must carry a server-issued
  // capability, and the absence of one must yield no target at all.
  const builder = mainContent.slice(
    mainContent.indexOf('function buildExternalAttachTarget'),
    mainContent.indexOf('\n}', mainContent.indexOf('function buildExternalAttachTarget')),
  );
  assert.match(builder, /const isAttachOnly = externalTerminal\.cliKind === 'ssh'/);
  assert.match(builder, /typeof attachCapability === 'string' && attachCapability/);
  assert.match(builder, /targetClass: 'attach-only'[\s\S]*capability: attachCapability/);
  assert.match(builder, /:\s*null;/);
  assert.match(mainContent, /\{attachTarget \? \(/);
  assert.match(mainContent, /t\('shell\.attachCapabilityUnavailable'\)/);
});

test('protocol outdated errors remain terminal after socket close and suppress auto-connect', () => {
  const connection = readFileSync(new URL('./hooks/useShellConnection.ts', import.meta.url), 'utf8');

  assert.match(connection, /protocolOutdatedRef\.current = true/);
  assert.match(connection, /suppressAutoConnectRef\.current = true/);
  assert.match(connection, /protocolOutdatedRef\.current \|\|/);
  assert.match(connection, /connectToShell\(\{ automatic: true \}\)/);
});
test('init carries the acknowledged output seq only when one exists', () => {
  const withSeq = buildShellInitMessage({ ...baseInit, attachTarget: null, lastSeq: 42 });
  assert.equal((withSeq as { lastSeq?: number }).lastSeq, 42);

  const withoutSeq = buildShellInitMessage({ ...baseInit, attachTarget: null, lastSeq: null });
  assert.equal('lastSeq' in withoutSeq, false);
});

test('reconnects keep the screen and only a redraw replay clears it', () => {
  const connection = readFileSync(new URL('./hooks/useShellConnection.ts', import.meta.url), 'utf8');

  // onclose must not clear: the server decides between seamless resume
  // (replay only what was missed) and a full redraw via replay_start.
  const oncloseBody = connection.slice(
    connection.indexOf('socket.onclose'),
    connection.indexOf('socket.onerror'),
  );
  assert.equal(oncloseBody.includes('clearTerminalScreen()'), false);
  assert.match(connection, /message\.type === 'replay_start'/);
  assert.match(connection, /mode !== 'resume'/);
  assert.match(connection, /lastSeqRef\.current = message\.seq/);
  assert.match(connection, /lastSeq: lastSeqRef\.current/);
});
