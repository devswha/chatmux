import assert from 'node:assert/strict';
import test from 'node:test';

import type { FleetHostCatalog } from '../../fleet/discovery/hostCatalog';

import { remoteRouteSelection } from './remoteRouteSelection';

const LOCAL = '00000000-0000-4000-8000-000000000000';
const PEER = '11111111-1111-4111-8111-111111111111';
const catalog = {
  localHostId: LOCAL,
  rosterRevision: 1,
  hosts: new Map([[PEER, {
    descriptor: { hostId: PEER, displayLabel: 'studio', state: 'online', protocolVersion: 'fleet/1', capabilities: [] },
    epoch: 'peer-epoch', revision: 1, sync: 'synced', truncated: false,
    rows: {
      projects: [{ localId: 'project-1', displayName: 'Peer project' }],
      sessions: [{ localId: 'session-1', projectLocalId: 'project-1', provider: 'codex', summary: 'Remote work', lastActivityMs: 1 }],
      panes: [],
    },
  }]]),
} as FleetHostCatalog;

test('host-qualified deep links resolve display-safe project and session state from the peer catalog', () => {
  const selected = remoteRouteSelection(catalog, { hostId: PEER, localId: 'session-1' });
  assert.equal(selected?.project.hostId, PEER);
  assert.equal(selected?.project.fullPath, '');
  assert.equal(selected?.session.id, 'session-1');
  assert.equal(selected?.catalogued, true);
  assert.equal(remoteRouteSelection(catalog, { hostId: LOCAL, localId: 'session-1' }), null);
});

test('host-qualified deep links remain readable while their session is absent from the live catalog', () => {
  const selected = remoteRouteSelection(catalog, { hostId: PEER, localId: 'idle-session' });

  assert.equal(selected?.project.hostId, PEER);
  assert.equal(selected?.project.displayName, 'studio');
  assert.equal(selected?.session.id, 'idle-session');
  assert.equal(selected?.catalogued, false);
});
