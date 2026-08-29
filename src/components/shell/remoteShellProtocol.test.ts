import assert from 'node:assert/strict';
import test from 'node:test';

import { buildShellInitMessage } from './hooks/useShellConnection';
import { getShellWebSocketUrl } from './utils/socket';

const target = {
  kind: 'pane' as const,
  hostId: '22222222-2222-4222-8222-222222222222',
  localId: 'collision-pane',
  lane: 'external' as const,
  tmux: { socketPath: '/tmp/peer.sock', sessionId: '$1', windowId: '@1', paneId: '%1' },
  process: { pid: 41, startedAtMs: 8_000 },
};

const base = {
  projectPath: '', sessionId: null, hasSession: false, provider: 'external',
  cols: 120, rows: 40, initialCommand: null, isPlainShell: false,
  forceRestart: false, lastSeq: 17,
};

test('Given a remote exact pane, when shell init is built, then it uses remote attach without a controller shell command', () => {
  const message = buildShellInitMessage({
    ...base,
    attachTarget: { targetClass: 'remote-agent', target },
    remoteResume: null,
  });

  assert.deepEqual(message, {
    type: 'init', shellProtocolVersion: 2, mode: 'remote-attach', target,
    cols: 120, rows: 40, resume: null,
  });
  assert.equal(JSON.stringify(message).includes('initialCommand'), false);
  assert.equal(JSON.stringify(message).includes('projectPath'), false);
});

test('Given a remote target, when selecting the socket, then the owner-qualified gateway is used', () => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { location: { protocol: 'https:', host: 'hub.example' } },
  });

  assert.equal(getShellWebSocketUrl('remote-agent'), 'wss://hub.example/remote-shell');

  Reflect.deleteProperty(globalThis, 'window');
});
