import assert from 'node:assert/strict';
import test from 'node:test';

import type { FleetHostEntry } from '../discovery/hostCatalog';

import { remoteTargetState } from './remoteTargetState';

const HOST = '22222222-2222-4222-8222-222222222222';
const pane = {
  localId: 'collision-pane', lane: 'external' as const, tmuxName: 'agent',
  tmux: { socketPath: '/tmp/peer.sock', sessionId: '$1', windowId: '@1', paneId: '%1' },
  process: { pid: 41, startedAtMs: 8_000 }, kind: 'codex', providerSessionId: 'session',
  activity: 'idle', presence: 'present' as const,
};
const target = {
  hostId: HOST, hostLabel: 'Peer A', localId: pane.localId, lane: pane.lane,
  tmuxName: pane.tmuxName, tmux: pane.tmux, process: pane.process,
  kind: 'Codex', cliKind: 'codex' as const, project: null,
};
function entry(state: FleetHostEntry['descriptor']['state'], process = pane.process): FleetHostEntry {
  return {
    descriptor: {
      hostId: HOST, displayLabel: 'Peer A', state, protocolVersion: 'fleet/1',
      capabilities: ['terminal.attach', 'terminal.input', 'prompt.respond', 'session.terminate'],
    },
    sync: state === 'syncing' ? 'syncing' : 'synced', epoch: 'peer-epoch', revision: 4,
    rows: { projects: [], sessions: [], panes: [{ ...pane, process }] }, truncated: false,
  };
}

test('Given an online exact generation, when target admission is derived, then attach, input, and termination are enabled', () => {
  const state = remoteTargetState({ localHostId: null, hosts: new Map([[HOST, entry('online')]]) }, target);
  assert.deepEqual(state, {
    remote: true, ready: true, hostLabel: 'Peer A', state: 'online',
    canAttach: true, canInput: true, canRespond: true, canTerminate: true,
  });
});

test('Given pane reuse, when the process generation changes, then every action is stale and disabled', () => {
  const state = remoteTargetState({
    localHostId: null,
    hosts: new Map([[HOST, entry('online', { pid: 42, startedAtMs: 9_000 })]]),
  }, target);
  assert.equal(state.state, 'stale');
  assert.equal(state.ready, false);
  assert.equal(state.canAttach || state.canInput || state.canRespond || state.canTerminate, false);
});

test('Given syncing or offline peers, when state changes, then last-known targets remain labelled but disabled', () => {
  for (const peerState of ['syncing', 'offline'] as const) {
    const state = remoteTargetState({ localHostId: null, hosts: new Map([[HOST, entry(peerState)]]) }, target);
    assert.equal(state.hostLabel, 'Peer A');
    assert.equal(state.ready, false);
    assert.equal(state.state, peerState);
  }
});
