import assert from 'node:assert/strict';
import test from 'node:test';

import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';

import type { FleetHostCatalog, FleetHostEntry } from '../discovery/hostCatalog';
import { EMPTY_HOST_ROW_SET } from '../discovery/hostRows';

import { useRemoteTranscriptSync } from './useRemoteTranscriptSync';

const LOCAL = '11111111-1111-4111-8111-111111111111';
const PEER_A = '22222222-2222-4222-8222-222222222222';
const SESSION = 'session-collision';

function catalog(options: { readonly epoch: string; readonly activityMs: number; readonly localId?: string }): FleetHostCatalog {
  const entry: FleetHostEntry = {
    descriptor: { hostId: PEER_A, displayLabel: 'studio', state: 'online', protocolVersion: 'fleet/1', capabilities: ['catalog.read'] },
    sync: 'synced',
    epoch: options.epoch,
    revision: 2,
    rows: {
      ...EMPTY_HOST_ROW_SET,
      sessions: [{
        localId: options.localId ?? SESSION,
        projectLocalId: 'project-collision',
        provider: 'gjc',
        summary: 'collision',
        lastActivityMs: options.activityMs,
      }],
    },
    truncated: false,
  };
  return { localHostId: LOCAL, hosts: new Map([[PEER_A, entry]]) };
}

type Harness = {
  readonly refreshed: readonly string[];
  readonly update: (props: { readonly hostId: string | null; readonly catalog: FleetHostCatalog }) => void;
  readonly dispose: () => void;
};

function mount(props: { readonly hostId: string | null; readonly catalog: FleetHostCatalog }): Harness {
  const refreshed: string[] = [];
  function Surface({ hostId, catalog: hosts }: { hostId: string | null; catalog: FleetHostCatalog }) {
    useRemoteTranscriptSync({
      scope: { hostId, localHostId: LOCAL },
      sessionId: SESSION,
      catalog: hosts,
      refresh: (sessionId) => { refreshed.push(sessionId); return Promise.resolve(null); },
    });
    return null;
  }
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  act(() => { renderer = TestRenderer.create(createElement(Surface, props)); });
  const active = renderer;
  assert.ok(active);
  return {
    refreshed,
    update: (next) => act(() => { active.update(createElement(Surface, next)); }),
    dispose: () => act(() => { active.unmount(); }),
  };
}

test('Given a peer session just opened, when its first catalog row is observed, then the transcript is not re-read', (t) => {
  // Given / When
  const harness = mount({ hostId: PEER_A, catalog: catalog({ epoch: 'epoch-1', activityMs: 100 }) });
  t.after(harness.dispose);

  // Then
  assert.deepEqual(harness.refreshed, []);
});

test('Given an open peer session, when the host reports later activity, then the transcript window is re-read once per advance', (t) => {
  // Given
  const harness = mount({ hostId: PEER_A, catalog: catalog({ epoch: 'epoch-1', activityMs: 100 }) });
  t.after(harness.dispose);

  // When
  harness.update({ hostId: PEER_A, catalog: catalog({ epoch: 'epoch-1', activityMs: 220 }) });
  harness.update({ hostId: PEER_A, catalog: catalog({ epoch: 'epoch-1', activityMs: 220 }) });
  harness.update({ hostId: PEER_A, catalog: catalog({ epoch: 'epoch-1', activityMs: 340 }) });

  // Then
  assert.deepEqual(harness.refreshed, [SESSION, SESSION]);
});

test('Given a peer that restarted, when its catalog epoch changes, then the transcript is re-read even without newer activity', (t) => {
  // Given
  const harness = mount({ hostId: PEER_A, catalog: catalog({ epoch: 'epoch-1', activityMs: 100 }) });
  t.after(harness.dispose);

  // When
  harness.update({ hostId: PEER_A, catalog: catalog({ epoch: 'epoch-2', activityMs: 100 }) });

  // Then
  assert.deepEqual(harness.refreshed, [SESSION]);
});

test('Given a local session, when catalog activity changes, then nothing is re-read through the host route', (t) => {
  // Given
  const harness = mount({ hostId: LOCAL, catalog: catalog({ epoch: 'epoch-1', activityMs: 100 }) });
  t.after(harness.dispose);

  // When
  harness.update({ hostId: LOCAL, catalog: catalog({ epoch: 'epoch-1', activityMs: 500 }) });

  // Then
  assert.deepEqual(harness.refreshed, []);
});

test('Given a peer whose catalog holds another session, when that row changes, then the open session is not re-read', (t) => {
  // Given
  const harness = mount({ hostId: PEER_A, catalog: catalog({ epoch: 'epoch-1', activityMs: 100 }) });
  t.after(harness.dispose);

  // When
  harness.update({ hostId: PEER_A, catalog: catalog({ epoch: 'epoch-1', activityMs: 900, localId: 'other-session' }) });

  // Then
  assert.deepEqual(harness.refreshed, []);
});
