import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

import {
  SERVICE_WORKER_ACTIVATE_MESSAGE,
  createServiceWorkerRefreshCoordinator,
  type ServiceWorkerRefreshOptions,
} from './serviceWorkerUpdate';

class Events {
  private readonly listeners = new Map<string, Set<() => void>>();

  addEventListener(type: string, listener: () => void) {
    const listeners = this.listeners.get(type) || new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: () => void) {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string) {
    for (const listener of this.listeners.get(type) || []) listener();
  }
}

class Worker extends Events {
  state?: string;
  messages: string[] = [];
  onMessage?: () => void;

  postMessage(message: string) {
    this.messages.push(message);
    this.onMessage?.();
  }
}
async function flushAsyncWork() {
  await Promise.resolve();
  await Promise.resolve();
}


type RegistrationFixture = {
  waiting?: Worker | null;
  installing?: Worker | null;
  update?: () => Promise<RegistrationFixture>;
};

type ServiceWorkerFixture = Events & {
  controller?: object;
  register: () => Promise<RegistrationFixture>;
  getRegistration: () => Promise<RegistrationFixture | undefined>;
};

function setup({ controller = true, storage = new Map<string, string>(), navigationType = () => 'navigate', now = () => 1_000 }: {
  controller?: boolean;
  storage?: Map<string, string>;
  navigationType?: () => string;
  now?: () => number;
} = {}) {
  let registration: RegistrationFixture | undefined;
  let registerCalls = 0;
  const serviceWorker: ServiceWorkerFixture = Object.assign(new Events(), {
    controller: controller ? {} : undefined,
    register: async () => {
      registerCalls += 1;
      if (!registration) throw new Error('Registration is unavailable');
      return registration;
    },
    getRegistration: async () => registration,
  });

  let reloads = 0;
  const timers: Array<() => void> = [];
  const coordinator = createServiceWorkerRefreshCoordinator({
    navigator: { serviceWorker },
    location: { reload: () => { reloads += 1; } },
    sessionStorage: {
      getItem: key => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, value),
    },
    setTimeout: callback => {
      timers.push(callback);
      return timers.length;
    },
    clearTimeout: () => {},
    navigationType,
    now,
  });

  return {
    coordinator,
    serviceWorker,
    setRegistration(value: RegistrationFixture | undefined) { registration = value; },
    get reloads() { return reloads; },
    get registerCalls() { return registerCalls; },
    timers,
  };
}
test('shares registration and refresh coordination with verified server updates', async () => {
  const fixture = setup({ controller: false });
  fixture.setRegistration({});
  const options: ServiceWorkerRefreshOptions = { serverVersion: '1.2.3' };

  await Promise.all([fixture.coordinator.register(), fixture.coordinator.register()]);
  assert.equal(fixture.registerCalls, 1);
  assert.equal(await fixture.coordinator.refreshAfterServerUpdate(options), 'reloaded');
  assert.equal(await fixture.coordinator.refresh(options), 'already-reloaded');
  assert.equal(fixture.reloads, 1);
});

// Regression: the old per-version session guard let only the FIRST stale
// document reload; every other document restored from the back/forward cache
// stayed stranded on the old bundle (실사고: 모바일 PWA 뒤로가기/복귀마다 옛 UI).
test('every restored stale document heals; only reload-born documents are loop-blocked', async () => {
  const storage = new Map<string, string>();
  const options: ServiceWorkerRefreshOptions = { serverVersion: '2.0.0' };

  // Document A (bfcache restore of a stale bundle) reloads.
  const docA = setup({ controller: false, storage });
  docA.setRegistration({});
  assert.equal(await docA.coordinator.refreshAfterServerUpdate(options), 'reloaded');
  assert.equal(docA.reloads, 1);

  // Document B — another stale history entry in the SAME session — must also
  // be allowed to heal instead of being blocked by A's marker.
  const docB = setup({ controller: false, storage, now: () => 2_000 });
  docB.setRegistration({});
  assert.equal(await docB.coordinator.refreshAfterServerUpdate(options), 'reloaded');
  assert.equal(docB.reloads, 1);

  // Document C was itself produced by an auto-reload moments ago and still
  // mismatches: the origin serves a stale bundle — break the loop.
  const docC = setup({ controller: false, storage, navigationType: () => 'reload', now: () => 3_000 });
  docC.setRegistration({});
  assert.equal(await docC.coordinator.refreshAfterServerUpdate(options), 'already-reloaded');
  assert.equal(docC.reloads, 0);

  // Outside the loop window a reload-born document may retry (bounded retry).
  const docD = setup({ controller: false, storage, navigationType: () => 'reload', now: () => 40_000 });
  docD.setRegistration({});
  assert.equal(await docD.coordinator.refreshAfterServerUpdate(options), 'reloaded');
  assert.equal(docD.reloads, 1);
});
test('a failed initial registration can be retried', async () => {
  const fixture = setup({ controller: false });

  await assert.rejects(fixture.coordinator.register(), /Registration is unavailable/);
  fixture.setRegistration({});
  await fixture.coordinator.register();

  assert.equal(fixture.registerCalls, 2);
});

test('activates a waiting worker only after controllerchange listener is attached', async () => {
  const fixture = setup();
  const worker = new Worker();
  fixture.setRegistration({ waiting: worker });
  worker.onMessage = () => fixture.serviceWorker.emit('controllerchange');

  assert.equal(await fixture.coordinator.refresh({ serverVersion: '1.2.3' }), 'reloaded');
  assert.deepEqual(worker.messages, [SERVICE_WORKER_ACTIVATE_MESSAGE]);
  assert.equal(fixture.reloads, 1);
});

test('waits for an installing worker to become waiting', async () => {
  const fixture = setup();
  const worker = new Worker();
  const registration = { installing: worker, waiting: null as Worker | null };
  fixture.setRegistration(registration);
  worker.onMessage = () => fixture.serviceWorker.emit('controllerchange');

  const refreshing = fixture.coordinator.refresh({ serverVersion: '1.2.3' });
  await flushAsyncWork();
  registration.waiting = worker;
  worker.state = 'installed';
  worker.emit('statechange');

  assert.equal(await refreshing, 'reloaded');
  assert.equal(fixture.reloads, 1);
});

test('uses one ordinary reload when a controlled registration has no candidate', async () => {
  const fixture = setup();
  const registration: RegistrationFixture = {
    update: async () => registration,
  };
  fixture.setRegistration(registration);

  assert.equal(await fixture.coordinator.refresh({ serverVersion: '1.2.3' }), 'reloaded');
  assert.equal(await fixture.coordinator.refresh({ serverVersion: '1.2.3' }), 'already-reloaded');
  assert.equal(fixture.reloads, 1);
});

test('uses one ordinary reload when control or registration is absent', async () => {
  const uncontrolled = setup({ controller: false });
  uncontrolled.setRegistration({ waiting: new Worker() });
  assert.equal(await uncontrolled.coordinator.refresh({ serverVersion: '1.2.3' }), 'reloaded');

  const missing = setup();
  missing.setRegistration(undefined);
  assert.equal(await missing.coordinator.refresh({ serverVersion: '1.2.3' }), 'reloaded');
});

test('update errors are retryable and do not reload', async () => {
  const fixture = setup();
  const registration: RegistrationFixture = {
    update: async (): Promise<RegistrationFixture> => { throw new Error('offline'); },
  };
  fixture.setRegistration(registration);

  assert.equal(await fixture.coordinator.refresh({ serverVersion: '1.2.3' }), 'failed');
  registration.update = async () => registration;
  assert.equal(await fixture.coordinator.refresh({ serverVersion: '1.2.3' }), 'reloaded');
  assert.equal(fixture.reloads, 1);
});

test('activation timeout is retryable and does not reload', async () => {
  const fixture = setup();
  const worker = new Worker();
  fixture.setRegistration({ waiting: worker });

  const refreshing = fixture.coordinator.refresh({ serverVersion: '1.2.3' });
  await flushAsyncWork();
  fixture.timers.shift()?.();
  assert.equal(await refreshing, 'failed');
  assert.equal(fixture.reloads, 0);

  worker.onMessage = () => fixture.serviceWorker.emit('controllerchange');
  assert.equal(await fixture.coordinator.refresh({ serverVersion: '1.2.3' }), 'reloaded');
  assert.equal(fixture.reloads, 1);
});
test('service worker preserves push and notification click handlers with consent activation', async () => {
  const source = await readFile('public/sw.js', 'utf8');

  assert.match(source, /self\.addEventListener\('message'/);
  assert.match(source, /event\.data === ACTIVATE_MESSAGE/);
  assert.match(source, /event\.waitUntil\(self\.skipWaiting\(\)\)/);
  assert.match(source, /self\.addEventListener\('push'/);
  assert.match(source, /self\.addEventListener\('notificationclick'/);
  assert.doesNotMatch(
    source.match(/self\.addEventListener\('install'[\s\S]*?\n}\);/)?.[0] || '',
    /skipWaiting/,
  );
});
