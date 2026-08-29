import assert from 'node:assert/strict';
import test from 'node:test';

import type { FleetCapability, FleetPeerState } from '../../shared/fleet';

import type { FleetHostCatalog, FleetHostEntry, HostSyncState } from './discovery/hostCatalog';
import { EMPTY_HOST_ROW_SET } from './discovery/hostRows';
import { hostChatAvailability, spawnableHosts } from './hostAvailability';

const LOCAL = '11111111-1111-4111-8111-111111111111';
const PEER_A = '22222222-2222-4222-8222-222222222222';
const PEER_B = '33333333-3333-4333-8333-333333333333';

const ALL: readonly FleetCapability[] = ['catalog.read', 'session.read', 'chat.control', 'prompt.respond', 'session.spawn'];

function entry(
  hostId: string,
  state: FleetPeerState,
  options: { readonly sync?: HostSyncState; readonly capabilities?: readonly FleetCapability[]; readonly label?: string } = {},
): FleetHostEntry {
  return {
    descriptor: {
      hostId,
      displayLabel: options.label ?? 'studio',
      state,
      protocolVersion: state === 'incompatible' ? null : 'fleet/1',
      capabilities: options.capabilities ?? ALL,
    },
    sync: options.sync ?? 'synced',
    epoch: 'epoch-1',
    revision: 3,
    rows: EMPTY_HOST_ROW_SET,
    truncated: false,
  };
}

function catalog(...entries: readonly FleetHostEntry[]): FleetHostCatalog {
  return { localHostId: LOCAL, hosts: new Map(entries.map((value) => [value.descriptor.hostId, value])) };
}

test('Given the local host or an unknown identity, when chat availability is asked, then it is ready', () => {
  // Given / When / Then
  assert.equal(hostChatAvailability(catalog(), { hostId: LOCAL, localHostId: LOCAL }, 'chat.control'), 'ready');
  assert.equal(hostChatAvailability(catalog(), { hostId: null, localHostId: null }, 'chat.control'), 'ready');
});

test('Given each peer state, when chat availability is asked, then only a synchronized capable peer is ready', () => {
  // Given
  const scope = (hostId: string) => ({ hostId, localHostId: LOCAL });

  // When / Then
  assert.equal(hostChatAvailability(catalog(entry(PEER_A, 'online')), scope(PEER_A), 'chat.control'), 'ready');
  assert.equal(hostChatAvailability(catalog(entry(PEER_A, 'online', { sync: 'syncing' })), scope(PEER_A), 'chat.control'), 'syncing');
  assert.equal(hostChatAvailability(catalog(entry(PEER_A, 'syncing')), scope(PEER_A), 'chat.control'), 'syncing');
  assert.equal(hostChatAvailability(catalog(entry(PEER_A, 'connecting')), scope(PEER_A), 'chat.control'), 'syncing');
  assert.equal(hostChatAvailability(catalog(entry(PEER_A, 'degraded')), scope(PEER_A), 'chat.control'), 'unavailable');
  assert.equal(hostChatAvailability(catalog(entry(PEER_A, 'offline')), scope(PEER_A), 'chat.control'), 'unavailable');
  assert.equal(hostChatAvailability(catalog(entry(PEER_A, 'revoked')), scope(PEER_A), 'chat.control'), 'unavailable');
  assert.equal(hostChatAvailability(catalog(entry(PEER_A, 'incompatible')), scope(PEER_A), 'chat.control'), 'unavailable');
  assert.equal(
    hostChatAvailability(catalog(entry(PEER_A, 'online', { capabilities: ['catalog.read'] })), scope(PEER_A), 'chat.control'),
    'unavailable',
  );
  assert.equal(hostChatAvailability(catalog(), scope(PEER_A), 'chat.control'), 'unavailable');
});

test('Given a mixed fleet, when spawn targets are listed, then the local host leads and only online compatible peers follow', () => {
  // Given
  const hosts = catalog(
    entry(PEER_B, 'online', { label: 'beta' }),
    entry(PEER_A, 'offline', { label: 'alpha' }),
  );

  // When
  const choices = spawnableHosts(hosts, 'This machine');

  // Then
  assert.deepEqual(choices, [
    { hostId: LOCAL, label: 'This machine', isLocal: true },
    { hostId: PEER_B, label: 'beta', isLocal: false },
  ]);
});

test('Given peers without spawn capability or still synchronizing, when spawn targets are listed, then they are excluded', () => {
  // Given
  const hosts = catalog(
    entry(PEER_A, 'online', { capabilities: ['catalog.read', 'session.read'] }),
    entry(PEER_B, 'online', { sync: 'syncing' }),
  );

  // When
  const choices = spawnableHosts(hosts, 'This machine');

  // Then
  assert.deepEqual(choices.map((choice) => choice.hostId), [LOCAL]);
});

test('Given no known local host id, when spawn targets are listed, then the local machine is still offered alone', () => {
  // Given
  const hosts: FleetHostCatalog = { localHostId: null, hosts: new Map() };

  // When
  const choices = spawnableHosts(hosts, 'This machine');

  // Then
  assert.deepEqual(choices, [{ hostId: null, label: 'This machine', isLocal: true }]);
});
