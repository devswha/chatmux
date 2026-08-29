import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';

const moduleHooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === './useShellRuntime') {
      return {
        url: `data:text/javascript,${encodeURIComponent(`
          export function useShellRuntime(options) {
            globalThis.__restartHarness.runtimeOptions.push(options);
            return globalThis.__restartHarness.runtime;
          }
        `)}`,
        shortCircuit: true,
      };
    }
    return nextResolve(specifier, context);
  },
});
const { useRestartableShellRuntime } = await import('./useRestartableShellRuntime');
moduleHooks.deregister();

type RestartHarness = {
  runtimeOptions: Array<{ readonly isRestarting: boolean }>;
  restartShell: (() => void) | null;
  connectCalls: Array<{ readonly forceRestart?: boolean }>;
  runtime: ReturnType<typeof createRuntime>;
};

function createRuntime(connectCalls: Array<{ readonly forceRestart?: boolean }>) {
  return {
    terminalContainerRef: { current: null },
    terminalRef: { current: null },
    wsRef: { current: null },
    isConnected: false,
    isInitialized: true,
    isConnecting: false,
    isProtocolOutdated: false,
    connectToShell: (options?: { readonly forceRestart?: boolean }) => {
      connectCalls.push(options ?? {});
    },
    disconnectFromShell: () => undefined,
  };
}

function RestartProbe({ harness }: { readonly harness: RestartHarness }) {
  const runtime = useRestartableShellRuntime({
    selectedProject: null,
    selectedSession: null,
    initialCommand: null,
    isPlainShell: false,
    attachTarget: null,
    minimal: false,
    autoConnect: false,
    onProcessComplete: null,
  });
  harness.restartShell = runtime.restartShell;
  return null;
}

test('Given an initialized shell, when restart completes, then it reconnects with force restart', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const connectCalls: RestartHarness['connectCalls'] = [];
  const harness: RestartHarness = {
    runtimeOptions: [],
    restartShell: null,
    connectCalls,
    runtime: createRuntime(connectCalls),
  };
  Object.defineProperty(globalThis, '__restartHarness', { configurable: true, value: harness });
  let renderer: TestRenderer.ReactTestRenderer | null = null;

  try {
    await act(async () => {
      renderer = TestRenderer.create(createElement(RestartProbe, { harness }));
    });
    assert.ok(harness.restartShell);

    await act(async () => {
      harness.restartShell?.();
    });
    assert.equal(harness.runtimeOptions.at(-1)?.isRestarting, true);
    assert.deepEqual(connectCalls, []);

    await act(async () => {
      context.mock.timers.tick(1_000);
    });
    assert.equal(harness.runtimeOptions.at(-1)?.isRestarting, false);
    assert.deepEqual(connectCalls, [{ forceRestart: true }]);
  } finally {
    if (renderer) {
      await act(async () => renderer?.unmount());
    }
    Reflect.deleteProperty(globalThis, '__restartHarness');
  }
});
