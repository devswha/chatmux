/**
 * Mounted driver for the fleet session route.
 *
 * It controls lifecycle around a production-wired fixture so tests can open
 * real URLs and inspect exactly what the application surface would expose.
 */
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';

import {
  identityArrival,
  mountedValue,
} from './mountedSessionDriverAssertions';
import type {
  Driver,
  DriverOptions,
} from './mountedSessionDriverContract';
import { createMountedSessionFixture, IDENTITY_URL } from './mountedSessionFixture';

export { IDENTITY_URL };
export type { Driver, SurfaceState } from './mountedSessionDriverContract';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

export function createDriver(options: DriverOptions): Driver {
  const fixture = createMountedSessionFixture(options);
  let renderer: ReactTestRenderer | undefined;
  let currentPath = '/';

  const settle = async () => {
    while (fixture.inFlight.length > 0) {
      const pending = fixture.inFlight.splice(0, fixture.inFlight.length);
      await act(async () => { await Promise.all(pending); });
    }
    await act(async () => { await tick(); });
  };

  const mount = async (path: string) => {
    currentPath = path;
    const identityReady = options.identity === null
      ? Promise.resolve()
      : identityArrival(options.identity);
    await act(async () => {
      renderer = TestRenderer.create(fixture.tree(path));
      await tick();
    });
    await act(async () => { await identityReady; });
    await settle();
  };

  return {
    requests: fixture.requests,
    sent: fixture.sent,
    mountReads: fixture.mountReads,
    navigate: async (path: string) => {
      const navigate = mountedValue(fixture.navigate(), 'navigate requires a mounted driver');
      currentPath = path;
      await act(async () => {
        navigate(path);
        await tick();
      });
      await settle();
    },
    render: async (path: string) => {
      if (renderer) {
        await act(async () => { renderer?.unmount(); });
        renderer = undefined;
      }
      await mount(path);
    },
    reload: async () => {
      await act(async () => { renderer?.unmount(); });
      renderer = undefined;
      await mount(currentPath);
    },
    unmount: async () => {
      await act(async () => { renderer?.unmount(); });
      renderer = undefined;
    },
    state: () => mountedValue(fixture.state()),
    settle,
    writeDraft: (content) => act(() => {
      fixture.writeDraft(content);
      renderer?.update(fixture.tree(currentPath));
    }),
    markProcessing: () => act(() => fixture.markProcessing()),
    markIdle: () => act(() => fixture.markIdle()),
    root: () => mountedValue(renderer),
  };
}
