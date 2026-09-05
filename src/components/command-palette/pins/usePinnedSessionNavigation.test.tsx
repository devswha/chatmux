import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';

import type { FleetHostCatalog, FleetHostEntry } from '../../../fleet/discovery/hostCatalog';
import { LOCAL_HOST_ID as LOCAL, PEER_A_HOST_ID as A, PEER_B_HOST_ID as B, peerDescriptor } from '../../../fleet/discovery/hostCatalog.testSupport';
import type { Project } from '../../../types/app';

import type { PinInventory, ResolvedPinnedSession } from './pinnedSessionInventory';
import { PINNED_SESSIONS_KEY, type PinnedSession } from './pinnedSessions';
import { usePinnedSessionNavigation } from './usePinnedSessionNavigation';

const pin = (hostId: string): PinnedSession => ({ hostId, projectId: 'project', sessionId: 'session' });
const local: Project = { projectId: 'project', fullPath: '', displayName: 'Local', sessions: [{ id: 'session', title: 'Local session', provider: 'gjc' }] };
const host = (hostId: string): FleetHostEntry => ({
  descriptor: peerDescriptor(hostId, 'Peer'), sync: 'synced', epoch: 'one', revision: 1, truncated: false,
  rows: { projects: [{ localId: 'project', displayName: 'Project' }], sessions: [{ localId: 'session', projectLocalId: 'project', summary: 'Peer session', provider: 'codex', lastActivityMs: 0 }], panes: [] },
});
const catalog = (): FleetHostCatalog => ({ localHostId: LOCAL, hosts: new Map([[A, host(A)], [B, host(B)]]) });

function mount(t: TestContext, pins: PinnedSession[] = []) {
  const storage = new Map<string, string>([[PINNED_SESSIONS_KEY, JSON.stringify({ version: 1, pins })]]);
  const handlers = new Set<(event: StorageEvent) => void>();
  let denied = false;
  let writes = 0;
  const port = {
    getItem: (key: string) => { if (denied) throw new Error('denied'); return storage.get(key) ?? null; },
    setItem: (key: string, value: string) => { if (denied) throw new Error('quota'); writes++; storage.set(key, value); },
  };
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    localStorage: port,
    addEventListener: (_: string, handler: (event: StorageEvent) => void) => handlers.add(handler),
    removeEventListener: (_: string, handler: (event: StorageEvent) => void) => handlers.delete(handler),
  } });
  let state!: ReturnType<typeof usePinnedSessionNavigation>;
  const opened: ResolvedPinnedSession[] = [];
  let inventory: PinInventory = { catalog: catalog(), projects: [local] };
  function Surface({ current }: { current: PinInventory }) {
    state = usePinnedSessionNavigation(current, (target) => opened.push(target));
    return null;
  }
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => { renderer = TestRenderer.create(createElement(Surface, { current: inventory })); });
  t.after(() => {
    act(() => renderer.unmount());
    if (original) Object.defineProperty(globalThis, 'window', original);
    else Reflect.deleteProperty(globalThis, 'window');
  });
  return {
    get state() { return state; },
    get writes() { return writes; },
    opened,
    denyStorage: () => { denied = true; },
    update: (next: PinInventory) => { inventory = next; act(() => renderer.update(createElement(Surface, { current: inventory }))); },
    storageEvent: (value: string | null, key: string | null = PINNED_SESSIONS_KEY) => {
      if (value === null) storage.delete(PINNED_SESSIONS_KEY);
      else storage.set(PINNED_SESSIONS_KEY, value);
      act(() => { for (const handler of handlers) handler({ key, storageArea: port } as StorageEvent); });
    },
  };
}

test('a retained pin click consults revoked/replaced/omitted current inventory and never another host with the same ID', (t) => {
  const harness = mount(t, [pin(LOCAL), pin(A), pin(B)]);
  const retained = harness.state.openPin;
  assert.equal(harness.writes, 0, 'mounting must not rewrite browser preferences');
  const revoked = { ...host(A), descriptor: { ...host(A).descriptor, state: 'revoked' as const } };
  const omitted = { ...host(A), rows: { ...host(A).rows, sessions: [] }, truncated: true };
  for (const hosts of [new Map([[B, host(B)]]), new Map([[A, revoked], [B, host(B)]]), new Map([[A, omitted], [B, host(B)]])]) {
    harness.update({ catalog: { localHostId: LOCAL, hosts }, projects: [local] });
    act(() => { assert.equal(retained(pin(A)), false); });
    assert.equal(harness.opened.length, 0);
  }
  act(() => { assert.equal(retained(pin(B)), true); });
  assert.equal(harness.opened[0]?.route, `/hosts/${B}/session/session`);
  assert.equal(harness.opened[0]?.session.__provider, 'codex');
  // The same old click resumes only when that exact peer/session is permitted again.
  harness.update({ catalog: catalog(), projects: [local] });
  act(() => { assert.equal(retained(pin(A)), true); });
  assert.equal(harness.opened[1]?.pin.hostId, A);
});

test('retained Pin handlers cannot add removed sessions, while Unpin remains usable and idempotent', (t) => {
  const harness = mount(t, [pin(A)]);
  const toggle = harness.state.togglePin;
  const remove = harness.state.unpin;
  harness.update({ catalog: { localHostId: LOCAL, hosts: new Map() }, projects: [] });
  act(() => toggle(pin(B)));
  assert.deepEqual(harness.state.pins, [pin(A)]);
  act(() => remove(pin(A)));
  act(() => remove(pin(A)));
  assert.deepEqual(harness.state.pins, []);
  act(() => toggle(pin(A)));
  assert.deepEqual(harness.state.pins, []);
});

test('storage failure preserves in-page toggles and reports the failure without crashing', (t) => {
  const harness = mount(t);
  harness.denyStorage();
  act(() => harness.state.togglePin(pin(LOCAL)));
  assert.deepEqual(harness.state.pins, [pin(LOCAL)]);
  assert.equal(harness.state.storageUnavailable, true);
  act(() => harness.state.unpin(pin(LOCAL)));
  assert.deepEqual(harness.state.pins, []);
});

test('storage events refresh the bounded shortlist, handle clear/corruption, and do not rewrite unrelated keys', (t) => {
  const harness = mount(t);
  const raw = JSON.stringify({ version: 1, pins: [pin(A), pin(B)] });
  harness.storageEvent(raw, 'unrelated.preference');
  assert.deepEqual(harness.state.pins, []);
  harness.storageEvent(raw);
  assert.deepEqual(harness.state.pins, [pin(A), pin(B)]);
  harness.storageEvent('{invalid');
  assert.deepEqual(harness.state.pins, []);
  harness.storageEvent(raw);
  harness.storageEvent(null, null);
  assert.deepEqual(harness.state.pins, []);
  assert.equal(harness.writes, 0);
});
