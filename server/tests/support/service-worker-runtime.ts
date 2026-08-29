import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';

export type StoredNotificationNavigation = Readonly<{
  readonly href: string;
  readonly sessionId: string | null;
  readonly hostId: string | null;
}>;

export type StoredNotificationOptions = Readonly<{
  readonly tag?: unknown;
  readonly renotify?: unknown;
  readonly data: Readonly<{
    readonly navigation: StoredNotificationNavigation;
    readonly sessionId?: unknown;
    readonly provider?: unknown;
    readonly tag?: unknown;
  }>;
}>;

export type NotificationRecord = Readonly<{
  readonly title: unknown;
  readonly options: StoredNotificationOptions;
}>;

export type ServiceWorkerClient = Readonly<{
  readonly url: string;
  readonly focus: () => Promise<void>;
  readonly navigate?: (target: string) => Promise<void>;
  readonly postMessage?: (message: unknown) => void;
}>;

type ServiceWorkerEventListener = (event: unknown) => void;

export async function serviceWorkerRuntime(): Promise<Readonly<{
  readonly click: (data: unknown) => Promise<void>;
  readonly clients: ServiceWorkerClient[];
  readonly notifications: NotificationRecord[];
  readonly openWindows: string[];
  readonly push: (payload: unknown) => Promise<void>;
}>> {
  const source = await readFile(new URL('../../../public/sw.js', import.meta.url), 'utf8');
  const listeners = new Map<string, ServiceWorkerEventListener>();
  const notifications: NotificationRecord[] = [];
  const clients: ServiceWorkerClient[] = [];
  const openWindows: string[] = [];
  const self = {
    addEventListener(type: string, listener: ServiceWorkerEventListener) {
      listeners.set(type, listener);
    },
    location: { origin: 'https://chatmux.test' },
    registration: {
      showNotification(title: unknown, options: StoredNotificationOptions) {
        notifications.push({ title, options });
        return Promise.resolve();
      },
    },
    clients: {
      claim() {},
      matchAll: async () => clients,
      openWindow: async (target: string) => { openWindows.push(target); },
    },
    skipWaiting() {},
  };

  runInContext(source, createContext({ self, URL }));

  async function push(payload: unknown): Promise<void> {
    const listener = listeners.get('push');
    assert.ok(listener);
    let completion: Promise<unknown> | undefined;
    listener({
      data: { json: () => payload },
      waitUntil(value: Promise<unknown>) { completion = Promise.resolve(value); },
    });
    await completion;
  }

  async function click(data: unknown): Promise<void> {
    const listener = listeners.get('notificationclick');
    assert.ok(listener);
    let completion: Promise<unknown> | undefined;
    listener({
      notification: { data, close() {} },
      waitUntil(value: Promise<unknown>) { completion = Promise.resolve(value); },
    });
    await completion;
  }

  return { click, clients, notifications, openWindows, push };
}
