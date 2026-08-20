import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { createElement, useRef } from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';

import { buildShellInitMessage, useShellConnection } from './hooks/useShellConnection';
import type { ShellAttachTarget } from './types/types';
import { CLIENT_RELOAD_REQUIRED } from './types/types';

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

type FakeSocket = {
  readyState: number;
  onopen: (() => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  sent: string[];
  open: () => void;
  close: () => void;
};

function installConnectionHarness() {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const originalWebSocket = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket');
  const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const sockets: FakeSocket[] = [];
  const timers = new Map<number, () => void>();
  let timerId = 0;

  class TestWebSocket implements FakeSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSED = 3;
    readyState = TestWebSocket.CONNECTING;
    onopen: (() => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    sent: string[] = [];

    constructor() {
      sockets.push(this);
    }

    send(message: string) {
      this.sent.push(message);
    }

    open() {
      this.readyState = TestWebSocket.OPEN;
      this.onopen?.();
    }

    close() {
      this.readyState = TestWebSocket.CLOSED;
      this.onclose?.();
    }
  }

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location: { protocol: 'http:', host: 'chatmux.test' },
      setTimeout(callback: () => void) {
        const id = ++timerId;
        timers.set(id, callback);
        return id;
      },
    },
  });
  Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: TestWebSocket });
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: () => null },
  });

  return {
    sockets,
    flushTimers() {
      while (timers.size > 0) {
        const callbacks = [...timers.values()];
        timers.clear();
        callbacks.forEach((callback) => callback());
      }
    },
    restore() {
      if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
      else Reflect.deleteProperty(globalThis, 'window');
      if (originalWebSocket) Object.defineProperty(globalThis, 'WebSocket', originalWebSocket);
      else Reflect.deleteProperty(globalThis, 'WebSocket');
      if (originalLocalStorage) Object.defineProperty(globalThis, 'localStorage', originalLocalStorage);
      else Reflect.deleteProperty(globalThis, 'localStorage');
    },
  };
}

function ConnectionProbe({ attachTarget, protocolStates, admissionStates }: {
  attachTarget: ShellAttachTarget;
  protocolStates: boolean[];
  admissionStates: boolean[];
}) {
  const wsRef = useRef<WebSocket | null>(null);
  const terminalRef = useRef({ cols: 120, rows: 40, write: () => undefined } as never);
  const fitAddonRef = useRef({ fit: () => undefined } as never);
  const selectedProjectRef = useRef(null);
  const projectPathRef = useRef<string | undefined>(undefined);
  const selectedSessionRef = useRef(null);
  const initialCommandRef = useRef(null);
  const isPlainShellRef = useRef(false);
  const attachTargetRef = useRef(attachTarget);
  const onProcessCompleteRef = useRef(null);
  const { isProtocolOutdated, isAttachCapabilityUnavailable } = useShellConnection({
    wsRef,
    terminalRef,
    fitAddonRef,
    selectedProjectRef,
    projectPathRef,
    selectedSessionRef,
    initialCommandRef,
    isPlainShellRef,
    attachTargetRef,
    onProcessCompleteRef,
    isInitialized: true,
    autoConnect: true,
    closeSocket: () => wsRef.current?.close(),
    clearTerminalScreen: () => undefined,
  });
  protocolStates.push(isProtocolOutdated);
  admissionStates.push(isAttachCapabilityUnavailable);
  return null;
}

async function mountConnectionProbe(attachTarget: ShellAttachTarget) {
  const harness = installConnectionHarness();
  const protocolStates: boolean[] = [];
  const admissionStates: boolean[] = [];
  let renderer: ReactTestRenderer | null = null;
  try {
    await act(async () => {
      renderer = TestRenderer.create(createElement(ConnectionProbe, { attachTarget, protocolStates, admissionStates }));
    });
    assert.equal(harness.sockets.length, 1);
    await act(async () => {
      harness.sockets[0]!.open();
      harness.flushTimers();
    });
    return { harness, protocolStates, admissionStates, renderer: renderer! };
  } catch (error) {
    (renderer as ReactTestRenderer | null)?.unmount();
    harness.restore();
    throw error;
  }
}

test('typed attach init uses coordinates without an initial command', () => {
  const message = buildShellInitMessage({
    ...baseInit,
    attachTarget: { targetClass: 'local-agent', tmux, process },
  });

  assert.deepEqual(message, {
    type: 'terminal.init',
    protocolVersion: 3,
    projectPath: '/workspace/chatmux',
    sessionId: 'session-1',
    hasSession: true,
    provider: 'claude',
    cols: 120,
    rows: 40,
    forceRestart: false,
    mode: 'typed-attach',
    target: { runtime: 'tmux', tmux, targetClass: 'local-agent', process },
  });
  assert.equal('initialCommand' in message, false);
});
test('attach-only init includes its capability without a process or initial command', () => {
  const message = buildShellInitMessage({
    ...baseInit,
    attachTarget: { targetClass: 'attach-only', tmux, capability: 'opaque-capability' },
  });

  assert.deepEqual(message, {
    type: 'terminal.init',
    protocolVersion: 3,
    projectPath: '/workspace/chatmux',
    sessionId: 'session-1',
    hasSession: true,
    provider: 'claude',
    cols: 120,
    rows: 40,
    forceRestart: false,
    mode: 'typed-attach',
    target: { runtime: 'tmux', tmux, targetClass: 'attach-only', admissionCapability: 'opaque-capability' },
  });
  assert.equal('process' in message, false);
  assert.equal('initialCommand' in message, false);
});

test('Herdr attach uses strict shell v3 without legacy project or session fields', () => {
  const target = {
    runtime: 'herdr' as const,
    sourceId: 'hsrc_abcdefghijklmnopqrstuv',
    targetId: 'htgt_abcdefghijklmnopqrstuv',
    targetClass: 'attach-only' as const,
    admissionCapability: 'principal-bound-capability',
  };
  const message = buildShellInitMessage({
    ...baseInit,
    attachTarget: { runtime: 'herdr', target, mode: 'control' },
  });

  assert.deepEqual(message, {
    type: 'terminal.init',
    protocolVersion: 3,
    mode: 'control',
    target,
    cols: 120,
    rows: 40,
  });
  assert.equal('projectPath' in message, false);
  assert.equal('sessionId' in message, false);
});

test('null-project typed attach uses explicit context without session or command authority', () => {
  const message = buildShellInitMessage({
    ...baseInit,
    projectPath: '',
    sessionId: null,
    hasSession: false,
    provider: 'external',
    initialCommand: null,
    isPlainShell: false,
    attachTarget: { targetClass: 'local-agent', tmux, process },
  });

  assert.deepEqual(message, {
    type: 'terminal.init',
    protocolVersion: 3,
    projectPath: '',
    sessionId: null,
    hasSession: false,
    provider: 'external',
    cols: 120,
    rows: 40,
    forceRestart: false,
    mode: 'typed-attach',
    target: { runtime: 'tmux', tmux, targetClass: 'local-agent', process },
  });
});

test('plain shell init keeps its existing fields and adds the protocol version', () => {
  const message = buildShellInitMessage({ ...baseInit, attachTarget: null });

  assert.deepEqual(message, {
    type: 'terminal.init',
    protocolVersion: 3,
    ...baseInit,
    mode: 'plain-shell',
  });
});

test('shell consumers retain their command props and no client tmux command builder remains', () => {
  const mainContent = readFileSync(new URL('../main-content/view/MainContent.tsx', import.meta.url), 'utf8');
  const providerLogin = readFileSync(new URL('../provider-auth/view/ProviderLoginModal.tsx', import.meta.url), 'utf8');
  const standalone = readFileSync(new URL('../standalone-shell/view/StandaloneShell.tsx', import.meta.url), 'utf8');
  const removedBuilder = ['buildExact', 'TmuxAttachCommand'].join('');
  assert.equal(mainContent.includes(removedBuilder), false);
  assert.match(mainContent, /attachTarget=\{attachTarget\}/);
  assert.match(providerLogin, /StandaloneShell project=\{DEFAULT_PROJECT_FOR_EMPTY_SHELL\} command=\{command\}/);
  assert.match(standalone, /initialCommand=\{command\}/);
});

test('shell view permits only typed attach without a Project', () => {
  const shell = readFileSync(new URL('./view/Shell.tsx', import.meta.url), 'utf8');
  const standalone = readFileSync(new URL('../standalone-shell/view/StandaloneShell.tsx', import.meta.url), 'utf8');
  const connection = readFileSync(new URL('./hooks/useShellConnection.ts', import.meta.url), 'utf8');

  assert.match(shell, /if \(!selectedProject && !attachTarget\)/);
  assert.match(standalone, /if \(!project && !attachTarget\)/);
  assert.match(connection, /\(!currentProject && !currentAttachTarget\)/);
  assert.match(connection, /provider: typedAttach[\s\S]*\? 'external'/);
  assert.match(connection, /sessionId: typedAttach \|\| isPlainShellRef\.current/);
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

test('CLIENT_RELOAD_REQUIRED is terminal and suppresses automatic reconnect', async () => {
  const { harness, protocolStates, renderer } = await mountConnectionProbe({
    targetClass: 'local-agent',
    tmux,
    process,
  });
  try {
    await act(async () => {
      harness.sockets[0]!.onmessage?.({
        data: JSON.stringify({
          type: 'error',
          code: CLIENT_RELOAD_REQUIRED,
        }),
      } as MessageEvent);
      harness.sockets[0]!.close();
    });
    assert.equal(protocolStates[protocolStates.length - 1], true);
    assert.equal(harness.sockets.length, 1);
  } finally {
    await act(async () => { renderer.unmount(); });
    harness.restore();
  }
});

test('auth_url messages surface the provider login URL in the terminal', () => {
  const connection = readFileSync(new URL('./hooks/useShellConnection.ts', import.meta.url), 'utf8');
  const types = readFileSync(new URL('./types/types.ts', import.meta.url), 'utf8');
  const authUrlHandler = connection.slice(
    connection.indexOf("message.type === 'auth_url'"),
    connection.indexOf("message.type === 'replay_start'"),
  );

  assert.match(types, /\{ type: 'auth_url'; url\?: string; autoOpen\?: boolean \}/);
  assert.match(authUrlHandler, /terminalRef\.current\?\.write/);
  assert.match(authUrlHandler, /Authentication required/);
  assert.match(authUrlHandler, /message\.url/);
  assert.match(authUrlHandler, /onOutputRef\?\.current\?\.\(\)/);
  assert.equal(authUrlHandler.includes('window.open'), false);
});
test('init carries the acknowledged output seq only when one exists', () => {
  const withSeq = buildShellInitMessage({ ...baseInit, attachTarget: null, lastSeq: 42 });
  assert.equal((withSeq as { lastSeq?: number }).lastSeq, 42);

  const withoutSeq = buildShellInitMessage({ ...baseInit, attachTarget: null, lastSeq: null });
  assert.equal('lastSeq' in withoutSeq, false);
});

test('Herdr disconnect never replays its consumed admission capability', async () => {
  const target = {
    runtime: 'herdr' as const,
    sourceId: 'hsrc_abcdefghijklmnopqrstuv',
    targetId: 'htgt_abcdefghijklmnopqrstuv',
    targetClass: 'attach-only' as const,
    admissionCapability: 'single-use-capability',
  };
  const { admissionStates, harness, protocolStates, renderer } = await mountConnectionProbe({
    runtime: 'herdr',
    target,
    mode: 'control',
  });
  try {
    assert.deepEqual(
      harness.sockets[0]!.sent.map((message) => JSON.parse(message)),
      [{ type: 'terminal.init', protocolVersion: 3, mode: 'control', target, cols: 120, rows: 40 }],
    );
    await act(async () => { harness.sockets[0]!.close(); });
    assert.equal(protocolStates[protocolStates.length - 1], false);
    assert.equal(admissionStates[admissionStates.length - 1], true);
    assert.equal(harness.sockets.length, 1);
  } finally {
    await act(async () => { renderer.unmount(); });
    harness.restore();
  }
});

test('typed tmux target reconnects after a socket close', async () => {
  const { harness, renderer } = await mountConnectionProbe({
    targetClass: 'local-agent',
    tmux,
    process,
  });
  try {
    await act(async () => { harness.sockets[0]!.close(); });
    assert.equal(harness.sockets.length, 2);
  } finally {
    await act(async () => { renderer.unmount(); });
    harness.restore();
  }
});
