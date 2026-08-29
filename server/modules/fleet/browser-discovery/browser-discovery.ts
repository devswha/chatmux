import {
  FLEET_PROTOCOL_VERSION,
  type FleetPeerDescriptor,
} from '../../../../shared/fleet.js';
import type {
  FleetCatalogHostView,
  FleetCatalogNotification,
} from '../catalog/aggregator.js';
import type { HubPeerStatus } from '../hub/connection/types.js';
import { FleetBoundedWriter, type FleetWritableTransport } from '../protocol/bounded-writer.js';
import { FleetProtocolError } from '../protocol/errors.js';

import {
  type BrowserLocalDescriptor,
  deltaFrame,
  parseBrowserFleetCommand,
  rosterFrame,
  snapshotFrame,
  stateFrame,
} from './browser-frames.js';

export type BrowserFleetPeer = Readonly<{
  readonly peerId: string;
  readonly displayLabel: string;
  readonly enrollmentState: 'enrolled' | 'revoked';
}>;

export type FleetBrowserDiscoveryDependencies = Readonly<{
  readonly local: BrowserLocalDescriptor;
  readonly peers: Readonly<{ readonly list: () => readonly BrowserFleetPeer[] }>;
  readonly registry: Readonly<{
    readonly listStatuses: () => readonly HubPeerStatus[];
    readonly subscribeStatus: (listener: (status: HubPeerStatus) => void) => () => void;
    readonly requestCatalogSnapshot: (hostId: string) => string | undefined;
    readonly reconnect?: (hostId: string) => boolean;
    readonly reconcile?: () => void;
  }>;
  readonly catalog: Readonly<{
    readonly host: (hostId: string) => FleetCatalogHostView | undefined;
    readonly subscribe: (listener: (notification: FleetCatalogNotification) => void) => () => void;
  }>;
}>;

export type FleetBrowserSocket = FleetWritableTransport;

type Subscriber = Readonly<{
  readonly socket: FleetBrowserSocket;
  readonly writer: FleetBoundedWriter;
}>;

function assertNever(value: never): never {
  throw new TypeError(`unsupported fleet browser variant: ${String(value)}`);
}

function descriptor(
  peer: BrowserFleetPeer,
  status: HubPeerStatus | undefined,
): FleetPeerDescriptor {
  const enrollmentState = peer.enrollmentState;
  switch (enrollmentState) {
    case 'revoked':
      return {
        hostId: peer.peerId,
        displayLabel: peer.displayLabel,
        state: 'revoked',
        protocolVersion: status?.protocolVersion ?? null,
        capabilities: status?.capabilities ?? [],
      };
    case 'enrolled':
      return {
        hostId: peer.peerId,
        displayLabel: peer.displayLabel,
        state: status?.state ?? 'connecting',
        protocolVersion: status?.protocolVersion ?? null,
        capabilities: status?.capabilities ?? [],
      };
    default:
      return assertNever(enrollmentState);
  }
}

function localDescriptor(local: BrowserLocalDescriptor): FleetPeerDescriptor {
  return {
    hostId: local.hostId,
    displayLabel: local.displayLabel,
    state: 'online',
    protocolVersion: FLEET_PROTOCOL_VERSION,
    capabilities: local.capabilities,
  };
}

export function createFleetBrowserDiscovery(dependencies: FleetBrowserDiscoveryDependencies) {
  const subscribers = new Map<FleetBrowserSocket, Subscriber>();

  const peers = (): readonly BrowserFleetPeer[] => dependencies.peers.list();
  const statuses = (): ReadonlyMap<string, HubPeerStatus> => new Map(
    dependencies.registry.listStatuses().map((status) => [status.peerId, status]),
  );
  const hosts = (): readonly FleetPeerDescriptor[] => {
    const current = statuses();
    return [
      localDescriptor(dependencies.local),
      ...peers().map((peer) => descriptor(peer, current.get(peer.peerId))),
    ];
  };
  const send = (subscriber: Subscriber, frame: unknown): void => {
    try {
      subscriber.writer.send(JSON.stringify(frame));
    } catch (error) {
      if (error instanceof FleetProtocolError) {
        subscribers.delete(subscriber.socket);
        return;
      }
      throw error;
    }
  };
  const broadcast = (frame: unknown): void => {
    for (const subscriber of subscribers.values()) send(subscriber, frame);
  };
  const sendInitial = (subscriber: Subscriber): void => {
    send(subscriber, rosterFrame(dependencies.local.hostId, hosts()));
    const current = statuses();
    for (const peer of peers()) {
      send(subscriber, stateFrame(descriptor(peer, current.get(peer.peerId))));
      const entry = dependencies.catalog.host(peer.peerId);
      if (entry !== undefined) send(subscriber, snapshotFrame(peer.peerId, entry.snapshot));
    }
  };
  const unsubscribeStatus = dependencies.registry.subscribeStatus((status) => {
    const peer = peers().find((candidate) => candidate.peerId === status.peerId);
    if (peer !== undefined) broadcast(stateFrame(descriptor(peer, status)));
  });
  const unsubscribeCatalog = dependencies.catalog.subscribe((notification) => {
    switch (notification.kind) {
      case 'snapshot':
        broadcast(snapshotFrame(notification.hostId, notification.snapshot));
        return;
      case 'delta':
        broadcast(deltaFrame(notification.hostId, notification.delta));
        return;
      default:
        assertNever(notification);
    }
  });

  return {
    hosts,
    statuses: () => dependencies.registry.listStatuses(),
    reconnect: (hostId: string) => dependencies.registry.reconnect?.(hostId) ?? false,
    reconcile: () => dependencies.registry.reconcile?.(),
    handle(socket: FleetBrowserSocket, value: unknown, owner: boolean): boolean {
      const type = typeof value === 'object' && value !== null && 'type' in value
        ? value.type
        : undefined;
      if (typeof type !== 'string' || !type.startsWith('fleet.')) return false;
      if (!owner) {
        socket.send(JSON.stringify({ kind: 'protocol_error', code: 'FLEET_UNAUTHORIZED' }), () => undefined);
        return true;
      }
      const command = parseBrowserFleetCommand(value);
      if (command === null) {
        socket.send(JSON.stringify({ kind: 'protocol_error', code: 'FLEET_MALFORMED_FRAME' }), () => undefined);
        return true;
      }
      switch (command.type) {
        case 'fleet.subscribe': {
          const subscriber = subscribers.get(socket) ?? {
            socket,
            writer: new FleetBoundedWriter(socket),
          };
          subscribers.set(socket, subscriber);
          sendInitial(subscriber);
          return true;
        }
        case 'fleet.resync': {
          const enrolled = peers().some((peer) => (
            peer.peerId === command.hostId && peer.enrollmentState === 'enrolled'
          ));
          if (!subscribers.has(socket) || !enrolled) {
            socket.send(JSON.stringify({ kind: 'protocol_error', code: 'HOST_NOT_FOUND' }), () => undefined);
            return true;
          }
          const subscriber = subscribers.get(socket);
          const current = dependencies.catalog.host(command.hostId);
          if (subscriber !== undefined && current !== undefined) {
            send(subscriber, snapshotFrame(command.hostId, current.snapshot));
          }
          dependencies.registry.requestCatalogSnapshot(command.hostId);
          return true;
        }
        default:
          return assertNever(command);
      }
    },
    close(socket: FleetBrowserSocket): void {
      subscribers.delete(socket);
    },
    dispose(): void {
      unsubscribeCatalog();
      unsubscribeStatus();
      subscribers.clear();
    },
  };
}

export type FleetBrowserDiscovery = ReturnType<typeof createFleetBrowserDiscovery>;
