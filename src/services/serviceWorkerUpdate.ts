export const SERVICE_WORKER_ACTIVATE_MESSAGE = 'chatmux:activate';

const DEFAULT_TIMEOUT_MS = 10_000;
const SESSION_GUARD_PREFIX = 'chatmux:service-worker-refresh:';
/** A reload-born document still mismatching within this window means the origin keeps serving a stale bundle. */
const RELOAD_LOOP_WINDOW_MS = 30_000;

export type ServiceWorkerRefreshResult = 'reloaded' | 'already-reloaded' | 'failed';

type ServiceWorkerLike = {
  state?: string;
  postMessage(message: string): void;
  addEventListener(type: 'statechange', listener: () => void): void;
  removeEventListener(type: 'statechange', listener: () => void): void;
};

type RegistrationLike = {
  waiting?: ServiceWorkerLike | null;
  installing?: ServiceWorkerLike | null;
  update?: () => Promise<RegistrationLike>;
};

type ServiceWorkerContainerLike = {
  controller?: unknown;
  register?: (scriptURL: string) => Promise<RegistrationLike>;
  getRegistration?: () => Promise<RegistrationLike | undefined>;
  addEventListener(type: 'controllerchange', listener: () => void): void;
  removeEventListener(type: 'controllerchange', listener: () => void): void;
};

type RefreshDependencies = {
  navigator?: { serviceWorker?: ServiceWorkerContainerLike };
  location?: { reload(): void };
  sessionStorage?: Pick<Storage, 'getItem' | 'setItem'>;
  setTimeout?: (callback: () => void, ms: number) => unknown;
  clearTimeout?: (timer: unknown) => void;
  timeoutMs?: number;
  /** How this document was created; 'reload' marks a document our own reload produced. */
  navigationType?: () => string;
  now?: () => number;
};

export type ServiceWorkerRefreshOptions = RefreshDependencies & {
  registration?: RegistrationLike;
  serverVersion?: string;
};

function browserDependencies(): Required<Pick<RefreshDependencies, 'navigator' | 'location' | 'sessionStorage' | 'setTimeout' | 'clearTimeout' | 'navigationType' | 'now'>> {
  return {
    navigator: globalThis.navigator,
    location: globalThis.location,
    sessionStorage: globalThis.sessionStorage,
    setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
    clearTimeout: timer => {
      if (typeof timer === 'number') globalThis.clearTimeout(timer);
    },
    navigationType: () => {
      try {
        const [entry] = globalThis.performance.getEntriesByType('navigation');
        return entry instanceof PerformanceNavigationTiming ? entry.type : '';
      } catch {
        return '';
      }
    },
    now: Date.now,
  };
}

export function createServiceWorkerRefreshCoordinator(defaultDependencies: RefreshDependencies = {}) {
  type RefreshOptions = ServiceWorkerRefreshOptions;
  let registrationPromise: Promise<RegistrationLike> | null = null;
  let refreshPromise: Promise<ServiceWorkerRefreshResult> | null = null;

  function dependencies(overrides: RefreshDependencies = {}) {
    return { ...browserDependencies(), ...defaultDependencies, ...overrides };
  }

  // One reload per document: later callers in the same (about to be replaced)
  // document short-circuit. Unlike a per-version session guard, this lets EVERY
  // stale document restored from the back/forward cache heal itself — a
  // session-lifetime guard stranded all but the first one on the old bundle.
  let reloadedThisDocument = false;

  function reloadOnce(options: RefreshOptions): Extract<ServiceWorkerRefreshResult, 'reloaded' | 'already-reloaded'> {
    const resolved = dependencies(options);
    if (reloadedThisDocument) return 'already-reloaded';
    const guardKey = `${SESSION_GUARD_PREFIX}${options.serverVersion || 'unknown'}`;
    // Loop breaker: this document was itself born from an auto-reload for the
    // same server version moments ago and STILL mismatches — the origin keeps
    // serving a stale bundle, so another reload would spin forever.
    let markerAt: number | null = null;
    try {
      const marker: unknown = JSON.parse(resolved.sessionStorage.getItem(guardKey) ?? 'null');
      if (marker && typeof marker === 'object' && 'at' in marker && typeof marker.at === 'number') {
        markerAt = marker.at;
      }
    } catch { /* Legacy or corrupt marker: treat as absent. */ }
    const now = resolved.now();
    if (markerAt !== null && now - markerAt < RELOAD_LOOP_WINDOW_MS && resolved.navigationType() === 'reload') {
      return 'already-reloaded';
    }
    reloadedThisDocument = true;
    resolved.sessionStorage.setItem(guardKey, JSON.stringify({ at: now }));
    resolved.location.reload();
    return 'reloaded';
  }

  async function register(options: RefreshDependencies = {}): Promise<RegistrationLike> {
    if (!registrationPromise) {
      const serviceWorker = dependencies(options).navigator.serviceWorker;
      if (!serviceWorker?.register) {
        throw new Error('Service workers are unavailable');
      }
      const attempt = serviceWorker.register('/sw.js');
      registrationPromise = attempt.catch(error => {
        registrationPromise = null;
        throw error;
      });
    }
    return registrationPromise;
  }

  function waitForInstallingWorker(registration: RegistrationLike, worker: ServiceWorkerLike, options: RefreshOptions): Promise<ServiceWorkerLike | null> {
    const resolved = dependencies(options);
    const timeoutMs = options.timeoutMs ?? defaultDependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    return new Promise(resolve => {
      const finish = (candidate: ServiceWorkerLike | null) => {
        worker.removeEventListener('statechange', onStateChange);
        resolved.clearTimeout(timer);
        resolve(candidate);
      };
      const onStateChange = () => {
        if (registration.waiting) {
          finish(registration.waiting);
        } else if (worker.state === 'redundant') {
          finish(null);
        }
      };

      const timer = resolved.setTimeout(() => finish(null), timeoutMs);
      worker.addEventListener('statechange', onStateChange);
      onStateChange();
    });
  }

  function activateAndReload(worker: ServiceWorkerLike, options: RefreshOptions): Promise<ServiceWorkerRefreshResult> {
    const resolved = dependencies(options);
    const serviceWorker = resolved.navigator.serviceWorker;
    const timeoutMs = options.timeoutMs ?? defaultDependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!serviceWorker?.controller) return Promise.resolve(reloadOnce(options));

    return new Promise(resolve => {
      let settled = false;
      const finish = (result: ServiceWorkerRefreshResult) => {
        if (settled) return;
        settled = true;
        serviceWorker.removeEventListener('controllerchange', onControllerChange);
        resolved.clearTimeout(timer);
        resolve(result);
      };
      const onControllerChange = () => finish(reloadOnce(options));

      const timer = resolved.setTimeout(() => finish('failed'), timeoutMs);
      serviceWorker.addEventListener('controllerchange', onControllerChange);
      try {
        worker.postMessage(SERVICE_WORKER_ACTIVATE_MESSAGE);
      } catch {
        finish('failed');
      }
    });
  }

  async function refresh(options: RefreshOptions = {}): Promise<ServiceWorkerRefreshResult> {
    if (refreshPromise) return refreshPromise;

    refreshPromise = (async () => {
      const resolved = dependencies(options);
      const serviceWorker = resolved.navigator.serviceWorker;
      if (!serviceWorker) return reloadOnce(options);

      let registration = options.registration;
      try {
        registration ??= registrationPromise
          ? await registrationPromise
          : await serviceWorker.getRegistration?.();
      } catch {
        return 'failed';
      }

      if (!registration || !serviceWorker.controller) return reloadOnce(options);

      let worker = registration.waiting || null;
      if (!worker && registration.installing) {
        worker = await waitForInstallingWorker(registration, registration.installing, options);
      }

      if (!worker) {
        try {
          await registration.update?.();
        } catch {
          return 'failed';
        }
        worker = registration.waiting || null;
        if (!worker && registration.installing) {
          worker = await waitForInstallingWorker(registration, registration.installing, options);
        }
      }

      return worker ? activateAndReload(worker, options) : reloadOnce(options);
    })();

    try {
      return await refreshPromise;
    } finally {
      refreshPromise = null;
    }
  }

  return { register, refresh, refreshAfterServerUpdate: refresh };
}

const coordinator = createServiceWorkerRefreshCoordinator();

export const registerServiceWorker = coordinator.register;
export const requestServiceWorkerRefresh = coordinator.refresh;
export const refreshAfterServerUpdate = coordinator.refreshAfterServerUpdate;
