import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

import i18next from 'i18next';
import { createElement, useEffect, useRef } from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { I18nextProvider } from 'react-i18next';

import type { TmuxPaneIdentity } from '../../../../shared/tmux';
import { useShellConnection } from '../../shell/hooks/useShellConnection';
import type { ShellAttachTarget, ShellInitMessage } from '../../shell/types/types';

const xtermModules = new Map([
  ['@xterm/xterm', 'export class Terminal {}'],
  ['@xterm/addon-clipboard', 'export class ClipboardAddon {}'],
  ['@xterm/addon-fit', 'export class FitAddon {}'],
  ['@xterm/addon-image', 'export class ImageAddon {}'],
  ['@xterm/addon-web-links', 'export class WebLinksAddon {}'],
  ['@xterm/addon-webgl', 'export class WebglAddon {}'],
]);
const cssModuleHooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    const source = xtermModules.get(specifier);
    return source
      ? { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true }
      : nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith('.css')) {
      return { format: 'module', source: 'export default {};', shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});
const [
  { default: Shell },
  { default: StandaloneShell },
  { default: StandaloneShellEmptyState },
] = await Promise.all([
  import('../../shell/view/Shell'),
  import('./StandaloneShell'),
  import('./subcomponents/StandaloneShellEmptyState'),
]);
cssModuleHooks.deregister();
const shellI18n = i18next.createInstance();
await shellI18n.init({ lng: 'en', resources: { en: { translation: {} } } });

type FakeSocket = {
  readyState: number;
  onopen: (() => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  sent: string[];
  send: (message: string) => void;
  close: () => void;
  open: () => void;
};

type BrowserHarness = {
  sockets: FakeSocket[];
  flushTimers: () => void;
  restore: () => void;
};

function installBrowserGlobals(): BrowserHarness {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const originalWebSocket = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket');
  const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const sockets: FakeSocket[] = [];
  const timers = new Map<number, () => void>();
  let nextTimer = 1;

  class TestWebSocket {
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

    close() {
      this.readyState = TestWebSocket.CLOSED;
      this.onclose?.();
    }

    open() {
      this.readyState = TestWebSocket.OPEN;
      this.onopen?.();
    }
  }

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location: { protocol: 'http:', host: 'chatmux.test' },
      setTimeout(callback: () => void) {
        const id = nextTimer++;
        timers.set(id, callback);
        return id;
      },
      clearTimeout(id: number) {
        timers.delete(id);
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
    flushTimers: () => {
      while (timers.size > 0) {
        const callbacks = [...timers.values()];
        timers.clear();
        callbacks.forEach((callback) => callback());
      }
    },
    restore: () => {
      if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
      else Reflect.deleteProperty(globalThis, 'window');
      if (originalWebSocket) Object.defineProperty(globalThis, 'WebSocket', originalWebSocket);
      else Reflect.deleteProperty(globalThis, 'WebSocket');
      if (originalLocalStorage) Object.defineProperty(globalThis, 'localStorage', originalLocalStorage);
      else Reflect.deleteProperty(globalThis, 'localStorage');
    },
  };
}

const tmux: TmuxPaneIdentity = {
  socketPath: '/tmp/chatmux-typed-attach.sock',
  sessionId: '$typed',
  windowId: '@4',
  paneId: '%9',
};

function ConnectionProbe({ attachTarget, projectPath }: {
  attachTarget: ShellAttachTarget;
  projectPath?: string;
}) {
  const wsRef = useRef<WebSocket | null>(null);
  const terminalRef = useRef({ cols: 101, rows: 42 } as never);
  const fitAddonRef = useRef({ fit: () => undefined } as never);
  const selectedProjectRef = useRef(null);
  const projectPathRef = useRef(projectPath);
  const selectedSessionRef = useRef(null);
  const initialCommandRef = useRef(null);
  const isPlainShellRef = useRef(false);
  const attachTargetRef = useRef(attachTarget);
  const onProcessCompleteRef = useRef(null);
  useEffect(() => () => { wsRef.current?.close(); }, []);

  useShellConnection({
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
  return null;
}

function requireRenderer(renderer: ReactTestRenderer | null): ReactTestRenderer {
  assert.ok(renderer, 'test renderer is mounted');
  return renderer;
}

async function mountTypedAttach(target: ShellAttachTarget, projectPath?: string) {
  const browser = installBrowserGlobals();
  let renderer: ReactTestRenderer | null = null;
  try {
    await act(async () => {
      renderer = TestRenderer.create(createElement(ConnectionProbe, { attachTarget: target, projectPath }));
    });
    const mountedRenderer = requireRenderer(renderer);
    assert.equal(browser.sockets.length, 1, 'one connection is created for the target');

    await act(async () => {
      browser.sockets[0]!.open();
      browser.flushTimers();
    });
    const messages = browser.sockets[0]!.sent.map((message) => JSON.parse(message) as ShellInitMessage);
    return { browser, renderer: mountedRenderer, messages };
  } catch (error) {
    if (renderer) await act(async () => { renderer!.unmount(); });
    browser.restore();
    throw error;
  }
}

for (const { name, target, projectPath, expected } of [
  {
    name: 'local-agent target preserves tmux and process generation with the supplied project path',
    target: {
      targetClass: 'local-agent' as const,
      tmux,
      process: { pid: 4242, startedAtMs: 1_700_000_004_242 },
    },
    projectPath: '/workspace/local-agent',
    expected: {
      type: 'terminal.init',
      protocolVersion: 3,
      projectPath: '/workspace/local-agent',
      sessionId: null,
      hasSession: false,
      provider: 'external',
      cols: 101,
      rows: 42,
      forceRestart: false,
      mode: 'typed-attach',
      target: {
        runtime: 'tmux',
        targetClass: 'local-agent',
        tmux,
        process: { pid: 4242, startedAtMs: 1_700_000_004_242 },
      },
    },
  },
  {
    name: 'attach-only target preserves tmux and capability with an empty project path',
    target: {
      targetClass: 'attach-only' as const,
      tmux,
      capability: 'attach-capability-9',
    },
    projectPath: undefined,
    expected: {
      type: 'terminal.init',
      protocolVersion: 3,
      projectPath: '',
      sessionId: null,
      hasSession: false,
      provider: 'external',
      cols: 101,
      rows: 42,
      forceRestart: false,
      mode: 'typed-attach',
      target: {
        runtime: 'tmux',
        targetClass: 'attach-only',
        tmux,
        admissionCapability: 'attach-capability-9',
      },
    },
  },
]) {
  test(`mounted typed attach: ${name}`, async () => {
    const { browser, renderer, messages } = await mountTypedAttach(target, projectPath);
    try {
      assert.deepEqual(messages, [expected]);

      const standalone = TestRenderer.create(createElement(
        I18nextProvider,
        { i18n: shellI18n },
        createElement(StandaloneShell, {
          project: null,
          projectPath,
          attachTarget: target,
          minimal: true,
        }),
      ));
      try {
        const shell = standalone.root.findByType(Shell);
        assert.equal(shell.props.selectedProject, null);
        assert.equal(shell.props.projectPath, projectPath);
        assert.equal(shell.props.attachTarget, target);
      } finally {
        standalone.unmount();
      }
    } finally {
      await act(async () => { renderer!.unmount(); });
      browser.restore();
    }
  });
}

test('mounted null-Project plain shell renders the empty state and opens no socket', async () => {
  const browser = installBrowserGlobals();
  let renderer: ReactTestRenderer | null = null;
  try {
    await act(async () => {
      renderer = TestRenderer.create(createElement(
        I18nextProvider,
        { i18n: shellI18n },
        createElement(StandaloneShell, {
          project: null,
          isPlainShell: true,
        }),
      ));
    });
    assert.equal(browser.sockets.length, 0);
    assert.ok(renderer!.root.findByType(StandaloneShellEmptyState));
    assert.throws(() => renderer!.root.findByType(Shell));
  } finally {
    if (renderer) await act(async () => { renderer!.unmount(); });
    browser.restore();
  }
});
