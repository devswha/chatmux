import assert from 'node:assert/strict';
import test from 'node:test';

import type { FleetPeerState } from '../../../../shared/fleet';
import { applyHostFrame, type FleetHostCatalog, type FleetHostEntry } from '../../../fleet/discovery/hostCatalog';
import { LOCAL_HOST_ID as LOCAL, PEER_A_HOST_ID as A, PEER_B_HOST_ID as B, peerDescriptor } from '../../../fleet/discovery/hostCatalog.testSupport';
import type { Project } from '../../../types/app';

import { openPinnedSession, projectSessionPin, resolvePinnedSession, type PinInventory } from './pinnedSessionInventory';
import type { PinnedSession } from './pinnedSessions';

const pin = (hostId: string): PinnedSession => ({ hostId, projectId: 'same-project', sessionId: 'same-session' });
const local: Project = { projectId: 'same-project', fullPath: '/local/project', displayName: 'Local project', sessions: [{ id: 'same-session', title: 'Local session', __provider: 'claude' }] };
const peer = (hostId: string): FleetHostEntry => ({
  descriptor: peerDescriptor(hostId, hostId === A ? 'Peer A' : 'Peer B'),
  sync: 'synced', epoch: 'one', revision: 1, truncated: false,
  rows: {
    projects: [{ localId: 'same-project', displayName: 'Peer project' }],
    sessions: [{ localId: 'same-session', projectLocalId: 'same-project', provider: 'codex', summary: hostId === A ? 'A session' : 'B session', lastActivityMs: 1 }],
    panes: [],
  },
});
function inventory(): PinInventory {
  return { catalog: { localHostId: LOCAL, hosts: new Map([[A, peer(A)], [B, peer(B)]]) }, projects: [local] };
}
function withPeer(entry: FleetHostEntry): PinInventory {
  const state = inventory();
  return { ...state, catalog: { ...state.catalog, hosts: new Map([[A, entry], [B, peer(B)]]) } };
}

test('duplicate host/project/session IDs keep separate routes, current labels and provider targets', () => {
  const state = inventory();
  const targets = [LOCAL, A, B].map((hostId) => resolvePinnedSession(pin(hostId), state));
  assert.deepEqual(targets.map((target) => target?.route), [
    '/session/same-session', `/hosts/${A}/session/same-session`, `/hosts/${B}/session/same-session`,
  ]);
  assert.deepEqual(targets.map((target) => target?.label), ['Local session', 'A session', 'B session']);
  assert.deepEqual(targets.map((target) => target?.session.__provider), ['claude', 'codex', 'codex']);
  const selected: string[] = [];
  assert.equal(openPinnedSession(pin(A), state, (target) => selected.push(target.pin.hostId)), true);
  assert.deepEqual(selected, [A]);
});

test('cross-project pins resolve independently of the selected project and refresh their labels', () => {
  const other = { ...local, projectId: 'other-project', displayName: 'Other project', sessions: [{ id: 'other-session', title: 'Renamed now', __provider: 'gjc' as const }] };
  const target = { hostId: LOCAL, projectId: other.projectId, sessionId: 'other-session' };
  const state = { ...inventory(), projects: [local, other] };
  assert.equal(resolvePinnedSession(target, state)?.label, 'Renamed now');
  assert.equal(resolvePinnedSession(target, { ...state, projects: [local] }), null);
  assert.equal(resolvePinnedSession(target, { ...state, projects: [local, { ...other, sessions: [] }] }), null);
});

test('unknown identity, removed/replaced hosts and foreign local project rows never fall back to a matching ID', () => {
  const state = inventory();
  assert.equal(resolvePinnedSession(pin(A), { ...state, catalog: { ...state.catalog, localHostId: null } }), null);
  const removed = { ...state, catalog: { localHostId: LOCAL, hosts: new Map([[B, peer(B)]]) } };
  assert.equal(resolvePinnedSession(pin(A), removed), null);
  assert.equal(resolvePinnedSession(pin(LOCAL), { ...state, catalog: { ...state.catalog, localHostId: B } }), null);
  assert.equal(resolvePinnedSession(pin(LOCAL), { ...state, projects: [{ ...local, hostId: A }] }), null);
  assert.equal(resolvePinnedSession(pin(LOCAL), { ...state, projects: [{ ...local, hostId: 'hostunknown' }] }), null);
  assert.equal(projectSessionPin({ ...local, hostId: 'hostunknown' }, 'same-session', LOCAL), null);
  assert.equal(projectSessionPin(local, 'same-session', null), null);
  assert.deepEqual(projectSessionPin(local, 'same-session', LOCAL), pin(LOCAL));
});

test('all unavailable peer states, lost read capabilities and a sync gap block even retained rows', () => {
  for (const state of ['connecting', 'syncing', 'degraded', 'offline', 'revoked', 'incompatible'] as FleetPeerState[]) {
    const entry = peer(A);
    assert.equal(resolvePinnedSession(pin(A), withPeer({ ...entry, descriptor: { ...entry.descriptor, state } })), null, state);
  }
  for (const patch of [
    { sync: 'syncing' as const },
    { epoch: null },
    { descriptor: { ...peer(A).descriptor, protocolVersion: null } },
    { descriptor: { ...peer(A).descriptor, hostId: B } },
    { descriptor: { ...peer(A).descriptor, capabilities: ['catalog.read'] as const } },
    { descriptor: { ...peer(A).descriptor, capabilities: ['session.read'] as const } },
  ]) assert.equal(resolvePinnedSession(pin(A), withPeer({ ...peer(A), ...patch })), null);
});

test('snapshot replacement/omission, project reassignment and ambiguous rows cannot reopen a stale pin', () => {
  const state = inventory();
  const rendered = resolvePinnedSession(pin(A), state);
  assert.ok(rendered);
  const replacement: FleetHostCatalog = applyHostFrame(state.catalog, {
    kind: 'snapshot', hostId: A, epoch: 'two', revision: 2, rows: { projects: [], sessions: [], panes: [] },
  }).catalog;
  let navigations = 0;
  assert.equal(openPinnedSession(rendered.pin, { ...state, catalog: replacement }, () => navigations++), false);
  assert.equal(navigations, 0);
  assert.ok(resolvePinnedSession(pin(B), { ...state, catalog: replacement }));
  const entry = peer(A);
  for (const rows of [
    { ...entry.rows, sessions: [] },
    { ...entry.rows, projects: [] },
    { ...entry.rows, sessions: [{ ...entry.rows.sessions[0], projectLocalId: 'replaced-project' }] },
    { ...entry.rows, sessions: [...entry.rows.sessions, entry.rows.sessions[0]] },
  ]) assert.equal(resolvePinnedSession(pin(A), withPeer({ ...entry, rows, truncated: true })), null);
  // A truncated inventory still permits its explicitly present rows.
  assert.ok(resolvePinnedSession(pin(A), withPeer({ ...entry, truncated: true })));
});

test('local project/session removal and inconsistent membership disable pins without using stale selection', () => {
  const state = inventory();
  for (const projects of [[], [{ ...local, sessions: [] }], [{ ...local, sessions: [{ id: 'same-session', __projectId: 'other' }] }], [local, local]]) {
    assert.equal(resolvePinnedSession(pin(LOCAL), { ...state, projects }), null);
  }
});
