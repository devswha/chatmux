import type { ReactTestRenderer } from 'react-test-renderer';

import type { commonI18n } from './mountedBrowserEnvironment';

export type SurfaceState = {
  readonly localHostId: string | null;
  readonly routeKind: string;
  readonly storeHostId: string | null;
  readonly messageIds: readonly string[];
  readonly draft: string | null;
  readonly processingLocalIds: readonly string[];
};

export type MountRead = {
  readonly sessionKey: string | null;
  readonly draft: string | null;
};

export type DriverOptions = {
  readonly identity: string | null;
  readonly i18n: Awaited<ReturnType<typeof commonI18n>>;
  readonly messagesByUrl: ReadonlyMap<string, readonly string[]>;
};

export type Driver = {
  /** In-app navigation without unmounting the route boundary. */
  readonly navigate: (path: string) => Promise<void>;
  /** Lazy draft restores captured at every chat-surface mount, in order. */
  readonly mountReads: MountRead[];
  readonly render: (path: string) => Promise<void>;
  readonly reload: () => Promise<void>;
  readonly unmount: () => Promise<void>;
  readonly settle: () => Promise<void>;
  readonly requests: string[];
  readonly sent: unknown[];
  readonly state: () => SurfaceState;
  readonly writeDraft: (content: string) => void;
  readonly markProcessing: () => void;
  readonly markIdle: () => void;
  readonly root: () => ReactTestRenderer;
};
