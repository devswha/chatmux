/**
 * Harness for the host-aware new-session form: a fixed fleet catalog, a request
 * recorder that resolves on the request itself rather than on a delay, and the
 * few interactions the form exposes. Nothing here reimplements form logic.
 */
import assert from 'node:assert/strict';

import i18next from 'i18next';
import { createElement, type ReactElement } from 'react';
import { I18nextProvider } from 'react-i18next';
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer';

import enSidebar from '../../../../i18n/locales/en/sidebar.json';
import { FLEET_CAPABILITIES, type FleetCapability, type FleetPeerState } from '../../../../../shared/fleet';
import type { FleetHostCatalog, FleetHostEntry } from '../../../../fleet/discovery/hostCatalog';
import { EMPTY_HOST_ROW_SET } from '../../../../fleet/discovery/hostRows';
import { FleetHostCatalogContext } from '../../../../fleet/discovery/FleetHostCatalogContext';

import SidebarNewSession from './SidebarNewSession';

export const LOCAL = '11111111-1111-4111-8111-111111111111';
export const PEER_A = '22222222-2222-4222-8222-222222222222';
export const PEER_B = '33333333-3333-4333-8333-333333333333';

const i18n = i18next.createInstance();
await i18n.init({
  lng: 'en',
  fallbackLng: false,
  resources: { en: { sidebar: enSidebar } },
  ns: ['sidebar'],
  defaultNS: 'sidebar',
  interpolation: { escapeValue: false },
});

export function entry(hostId: string, state: FleetPeerState, options: {
  readonly sync?: 'synced' | 'syncing';
  readonly capabilities?: readonly FleetCapability[];
  readonly projectLocalId?: string;
} = {}): FleetHostEntry {
  return {
    descriptor: {
      hostId,
      displayLabel: `studio-${hostId.slice(0, 2)}`,
      state,
      protocolVersion: 'fleet/1',
      capabilities: options.capabilities ?? [...FLEET_CAPABILITIES],
    },
    sync: options.sync ?? 'synced',
    epoch: 'epoch-1',
    revision: 1,
    rows: {
      ...EMPTY_HOST_ROW_SET,
      projects: [{ localId: options.projectLocalId ?? 'project-collision', displayName: 'collision' }],
    },
    truncated: false,
  };
}

export function catalogOf(...entries: readonly FleetHostEntry[]): FleetHostCatalog {
  return {
    localHostId: LOCAL,
    hosts: new Map(entries.map((value) => [value.descriptor.hostId, value])),
  };
}

export type Harness = {
  readonly root: () => ReactTestInstance;
  readonly created: () => number;
  readonly refreshes: () => number;
  readonly dispose: () => void;
};

export function mount(catalog: FleetHostCatalog): Harness {
  let created = 0;
  let refreshes = 0;
  const tree = (): ReactElement => createElement(
    I18nextProvider,
    { i18n },
    createElement(
      FleetHostCatalogContext.Provider,
      { value: { catalog, hasRemoteHosts: catalog.hosts.size > 1, refresh: () => { refreshes += 1; } } },
      createElement(SidebarNewSession, { onCreated: () => { created += 1; }, initiallyOpen: true }),
    ),
  );
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  act(() => { renderer = TestRenderer.create(tree()); });
  const active = renderer;
  assert.ok(active);
  return {
    root: () => active.root,
    created: () => created,
    refreshes: () => refreshes,
    dispose: () => act(() => { active.unmount(); }),
  };
}

export function byAttribute(harness: Harness, attribute: string, value?: string): readonly ReactTestInstance[] {
  return harness.root().findAll((node) => typeof node.type === 'string'
    && node.props[attribute] !== undefined
    && (value === undefined || node.props[attribute] === value));
}

export function press(harness: Harness, attribute: string, value?: string): void {
  const found = byAttribute(harness, attribute, value);
  assert.equal(found.length, 1, `expected exactly one ${attribute}${value === undefined ? '' : `=${value}`}`);
  act(() => { (found[0]?.props as { onClick: () => void }).onClick(); });
}

export function type(harness: Harness, attribute: string, text: string, value?: string): void {
  const found = byAttribute(harness, attribute, value);
  assert.equal(found.length, 1, `expected exactly one ${attribute}`);
  act(() => { (found[0]?.props as { onChange: (event: unknown) => void }).onChange({ target: { value: text } }); });
}

export function reopen(harness: Harness): void {
  if (byAttribute(harness, 'data-spawn-open').length === 1) {
    press(harness, 'data-spawn-open');
  }
}

type FetchCall = { readonly url: string; readonly method: string; readonly body: unknown };
type FetchAnswer = { readonly status: number; readonly body: unknown } | 'reject';

const REQUEST_TIMEOUT_MS = 2_000;

export function stubFetch(): {
  readonly calls: readonly FetchCall[];
  readonly reply: (handler: (url: string) => FetchAnswer) => void;
  /** Resolves on the request itself, so no test ever waits on a fixed delay. */
  readonly awaitRequest: (matches: (url: string) => boolean) => Promise<void>;
  readonly restore: () => void;
} {
  const original = globalThis.fetch;
  const calls: FetchCall[] = [];
  const waiters = new Set<{ matches: (url: string) => boolean; settle: () => void }>();
  let handler: (url: string) => FetchAnswer = () => ({ status: 200, body: { data: { ok: true, reachable: true, conflict: false } } });
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
    });
    for (const waiter of [...waiters]) {
      if (!waiter.matches(url)) continue;
      waiters.delete(waiter);
      waiter.settle();
    }
    const answer = handler(url);
    if (answer === 'reject') return Promise.reject(new Error('socket closed'));
    return Promise.resolve(new Response(JSON.stringify(answer.body), {
      status: answer.status,
      headers: { 'content-type': 'application/json' },
    }));
  }) as typeof globalThis.fetch;
  return {
    calls,
    reply: (next) => { handler = next; },
    awaitRequest: (matches) => {
      if (calls.some((call) => matches(call.url))) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters.delete(waiter);
          reject(new Error('the expected request never happened'));
        }, REQUEST_TIMEOUT_MS);
        const waiter = { matches, settle: () => { clearTimeout(timer); resolve(); } };
        waiters.add(waiter);
      });
    },
    restore: () => { globalThis.fetch = original; },
  };
}

export const spawnCalls = (fetches: ReturnType<typeof stubFetch>) =>
  fetches.calls.filter((call) => call.url.includes('spawn'));

export async function dispatchLocal(
  harness: Harness,
  fetches: ReturnType<typeof stubFetch>,
  provider: string,
  name: string,
): Promise<void> {
  reopen(harness);
  press(harness, 'data-spawn-provider', provider);
  type(harness, 'data-spawn-name', name);
  type(harness, 'placeholder', '/home/me/app', enSidebar.newSessionForm.workingDirectoryPlaceholder);
  press(harness, 'data-spawn-submit');
  await act(async () => { await fetches.awaitRequest((url) => url.includes('spawn')); });
  await act(async () => { await Promise.resolve(); });
}

export async function dispatchPeer(harness: Harness, peer: string, name: string): Promise<void> {
  reopen(harness);
  press(harness, 'data-spawn-host', peer);
  type(harness, 'data-spawn-project', 'project-collision');
  type(harness, 'data-spawn-name', name);
  type(harness, 'data-peer-cwd-input', 'workspace/app/');
  press(harness, 'data-spawn-submit');
  await act(async () => { await Promise.resolve(); });
}

