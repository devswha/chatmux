/**
 * Host availability for session-bearing actions.
 *
 * The sidebar decides what a host group looks like; this decides whether the
 * browser may address a host at all. Both read the same catalog, so a host that
 * shows as offline or synchronizing there cannot be sent a chat frame or a spawn
 * request here.
 *
 * Availability is deliberately coarse: `ready` means online, synchronized and
 * capable, `syncing` means the host may become authoritative again shortly, and
 * `unavailable` means it must not be addressed. There is no "probably fine".
 */

import type { FleetCapability } from '../../shared/fleet';

import type { HostChatAvailability } from './chat/chatFrames';
import type { FleetHostCatalog, FleetHostEntry } from './discovery/hostCatalog';
import type { HostScope } from './hostApi/urls';
import { isLocalHostScope } from './hostApi/urls';

export type SpawnHostChoice = {
  /** Null only for the local machine before the server supplies its host id. */
  readonly hostId: string | null;
  readonly label: string;
  readonly isLocal: boolean;
};

function availabilityOf(entry: FleetHostEntry, capability: FleetCapability): HostChatAvailability {
  if (!entry.descriptor.capabilities.includes(capability)) {
    return 'unavailable';
  }
  switch (entry.descriptor.state) {
    case 'online':
      return entry.sync === 'synced' ? 'ready' : 'syncing';
    case 'connecting':
    case 'syncing':
      return 'syncing';
    case 'degraded':
    case 'offline':
    case 'revoked':
    case 'incompatible':
      return 'unavailable';
  }
}

/**
 * Whether the host owning the addressed session may be sent chat traffic. The
 * local host is always ready: its availability is the browser's own connection,
 * which the existing local behaviour already handles.
 */
export function hostChatAvailability(
  catalog: FleetHostCatalog,
  scope: HostScope,
  capability: FleetCapability,
): HostChatAvailability {
  if (isLocalHostScope(scope)) {
    return 'ready';
  }
  const entry = scope.hostId === null ? undefined : catalog.hosts.get(scope.hostId);
  return entry === undefined ? 'unavailable' : availabilityOf(entry, capability);
}

/**
 * Hosts a new session may be created on: the local machine first, then every
 * peer that is online, synchronized, protocol-compatible and spawn-capable. A
 * peer that cannot be addressed is not offered at all, so the form cannot send a
 * request that is guaranteed to fail.
 */
export function spawnableHosts(catalog: FleetHostCatalog, localLabel: string): readonly SpawnHostChoice[] {
  const local: SpawnHostChoice = { hostId: catalog.localHostId, label: localLabel, isLocal: true };
  const peers = [...catalog.hosts.values()]
    .filter((entry) => entry.descriptor.hostId !== catalog.localHostId)
    .filter((entry) => entry.descriptor.protocolVersion !== null)
    .filter((entry) => availabilityOf(entry, 'session.spawn') === 'ready')
    .map((entry): SpawnHostChoice => ({
      hostId: entry.descriptor.hostId,
      label: entry.descriptor.displayLabel,
      isLocal: false,
    }))
    .sort((first, second) => first.label.localeCompare(second.label) || (first.hostId ?? '').localeCompare(second.hostId ?? ''));
  return [local, ...peers];
}
