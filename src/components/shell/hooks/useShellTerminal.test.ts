import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

import { createElement, useRef } from 'react';
import TestRenderer, { act } from 'react-test-renderer';

const xtermModules = new Map([
  ['@xterm/xterm', `
    export class Terminal {
      constructor(options) {
        this.options = { ...options };
        this.cols = 80;
        this.rows = 24;
        globalThis.__shellTerminalHarness.terminals.push(this);
      }
      loadAddon(addon) {
        globalThis.__shellTerminalHarness.loadedAddons.push(addon.constructor.name);
        if (addon.constructor.name === 'ImageAddon' && globalThis.__shellTerminalHarness.imageLoadFails) {
          throw new Error('image addon unavailable');
        }
      }
      open() {}
      dispose() {}
      clear() {}
      write() {}
      onData() { return { dispose() {} }; }
      attachCustomKeyEventHandler() {}
      hasSelection() { return false; }
      getSelection() { return ''; }
      refresh() {}
    }
  `],
  ['@xterm/addon-clipboard', 'export class ClipboardAddon { constructor(...args) { this.args = args; } }'],
  ['@xterm/addon-fit', 'export class FitAddon { fit() {} }'],
  ['@xterm/addon-image', `
    export class ImageAddon {
      constructor(options) {
        globalThis.__shellTerminalHarness.imageOptions.push(options);
        if (globalThis.__shellTerminalHarness.imageConstructorFails) {
          throw new Error('image addon unavailable');
        }
      }
    }
  `],
  ['@xterm/addon-web-links', 'export class WebLinksAddon {}'],
  ['@xterm/addon-webgl', 'export class WebglAddon {}'],
]);
const moduleHooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    const source = xtermModules.get(specifier);
    return source
      ? { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true }
      : nextResolve(specifier, context);
  },
});
const { useShellTerminal } = await import('./useShellTerminal');
moduleHooks.deregister();

type Harness = {
  terminals: unknown[];
  loadedAddons: string[];
  imageOptions: Array<{ pixelLimit: number; storageLimit: number }>;
  imageConstructorFails: boolean;
  imageLoadFails: boolean;
};

type BrowserHarness = {
  restore: () => void;
};

function installBrowserGlobals(): BrowserHarness {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const originalResizeObserver = Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver');
  const timers = new Map<number, () => void>();
  let nextTimer = 1;

  class TestResizeObserver {
    observe() {}
    disconnect() {}
  }

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
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
  Object.defineProperty(globalThis, 'ResizeObserver', {
    configurable: true,
    value: TestResizeObserver,
  });

  return {
    restore: () => {
      if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
      else Reflect.deleteProperty(globalThis, 'window');
      if (originalResizeObserver) Object.defineProperty(globalThis, 'ResizeObserver', originalResizeObserver);
      else Reflect.deleteProperty(globalThis, 'ResizeObserver');
    },
  };
}

function TerminalProbe({ minimal }: { minimal: boolean }) {
  const terminalContainerRef = useRef({
    style: { setProperty() {}, removeProperty() {} },
    addEventListener() {},
    removeEventListener() {},
  } as never);
  const terminalRef = useRef(null);
  const fitAddonRef = useRef(null);
  const wsRef = useRef(null);

  useShellTerminal({
    terminalContainerRef,
    terminalRef,
    fitAddonRef,
    wsRef,
    terminalIdentityKey: 'terminal-1',
    minimal,
    isRestarting: false,
    closeSocket: () => undefined,
  });

  return null;
}

async function mountTerminal(harness: Harness, minimal = false) {
  Object.defineProperty(globalThis, '__shellTerminalHarness', {
    configurable: true,
    value: harness,
  });
  let renderer: TestRenderer.ReactTestRenderer | null = null;
  await act(async () => {
    renderer = TestRenderer.create(createElement(TerminalProbe, { minimal }));
  });
  return renderer!;
}

test('loads bounded image support before WebGL rendering', async () => {
  const browser = installBrowserGlobals();
  const harness: Harness = {
    terminals: [],
    loadedAddons: [],
    imageOptions: [],
    imageConstructorFails: false,
    imageLoadFails: false,
  };
  let renderer: TestRenderer.ReactTestRenderer | null = null;
  try {
    renderer = await mountTerminal(harness);

    assert.ok(harness.imageOptions.length > 0);
    assert.ok(harness.imageOptions.every((options) =>
      options.pixelLimit === 2048 * 2048 && options.storageLimit === 64,
    ));
    assert.ok(harness.loadedAddons.indexOf('ImageAddon') < harness.loadedAddons.indexOf('WebglAddon'));
    assert.ok(harness.loadedAddons.includes('WebglAddon'));
  } finally {
    if (renderer) await act(async () => { renderer!.unmount(); });
    browser.restore();
    Reflect.deleteProperty(globalThis, '__shellTerminalHarness');
  }
});

test('keeps WebGL rendering when image addon loading fails quietly', async () => {
  const browser = installBrowserGlobals();
  const harness: Harness = {
    terminals: [],
    loadedAddons: [],
    imageOptions: [],
    imageConstructorFails: false,
    imageLoadFails: true,
  };
  const originalWarn = console.warn;
  const warnings: unknown[][] = [];
  console.warn = (...args: unknown[]) => warnings.push(args);
  let renderer: TestRenderer.ReactTestRenderer | null = null;
  try {
    renderer = await mountTerminal(harness);

    assert.ok(harness.loadedAddons.includes('ImageAddon'));
    assert.ok(harness.loadedAddons.includes('WebglAddon'));
    assert.deepEqual(warnings, []);
  } finally {
    console.warn = originalWarn;
    if (renderer) await act(async () => { renderer!.unmount(); });
    browser.restore();
    Reflect.deleteProperty(globalThis, '__shellTerminalHarness');
  }
});
