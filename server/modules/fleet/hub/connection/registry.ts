import { FLEET_MAX_REMOTE_PEERS, type FleetCapability } from '../../../../../shared/fleet.js';
import type { FleetProtocolFrame } from '../../protocol/types.js';

import { HubPeerConnection } from './peer-connection.js';
import type { HubLocalIdentity, HubPeerConnectionOptions, HubPeerRecord, HubPeerSocket, HubPeerStatus } from './types.js';

export interface ManagedHubPeerConnection {
  start(): void;
  stop(state?: 'offline' | 'revoked'): void;
  reconnect(): void;
  markSynchronized(): void;
  markSyncing?(): void;
  requestCatalogSnapshot?(): string | undefined;
  sendFrame?(frame: Extract<FleetProtocolFrame, { readonly kind: 'request' }>): boolean;
  currentStatus(): HubPeerStatus;
}

export type HubPeerRegistryOptions = Readonly<{
  readonly peers: Readonly<{ list(): readonly HubPeerRecord[] }>;
  readonly assertRoleIntegrity?: () => void;
  readonly local: HubLocalIdentity;
  readonly scheduler: HubPeerConnectionOptions['scheduler'];
  readonly random: () => number;
  readonly dial: (target: URL) => HubPeerSocket;
  readonly requiredCapabilities?: readonly FleetCapability[];
  readonly recordNegotiation: (status: HubPeerStatus) => void;
  readonly onFrame: (peerId: string, frame: FleetProtocolFrame) => void;
  readonly createConnection?: (options: HubPeerConnectionOptions) => ManagedHubPeerConnection;
}>;

export class HubPeerConnectionRegistry {
  private readonly connections = new Map<string, Readonly<{ record: HubPeerRecord; connection: ManagedHubPeerConnection }>>();
  private readonly statuses = new Map<string, HubPeerStatus>();
  private readonly listeners = new Set<(status: HubPeerStatus) => void>();
  private readonly frameListeners = new Set<(peerId: string, frame: FleetProtocolFrame) => void>();
  private started = false;

  constructor(private readonly options: HubPeerRegistryOptions) {}

  start(): void { if (this.started) return; this.started = true; this.reconcile(); }
  stop(): void { if (!this.started) return; this.started = false; for (const managed of this.connections.values()) managed.connection.stop(); this.connections.clear(); }
  reconcile(): void {
    this.options.assertRoleIntegrity?.();
    const records = this.options.peers.list(); const byId = new Map(records.map((record) => [record.peerId, record]));
    for (const [peerId, managed] of this.connections) {
      const current = byId.get(peerId);
      if (current === undefined || current.enrollmentState === 'revoked') { managed.connection.stop(current?.enrollmentState === 'revoked' ? 'revoked' : 'offline'); this.connections.delete(peerId); }
      else if (this.changed(managed.record, current)) { managed.connection.stop(); this.connections.delete(peerId); }
    }
    if (!this.started) return;
    for (const record of records.filter((item) => item.enrollmentState === 'enrolled').slice(0, FLEET_MAX_REMOTE_PEERS)) {
      if (this.connections.has(record.peerId)) continue;
      const connection = this.create(record); this.connections.set(record.peerId, { record, connection }); connection.start();
    }
  }
  status(peerId: string): HubPeerStatus | undefined { return this.statuses.get(peerId); }
  listStatuses(): readonly HubPeerStatus[] { return [...this.statuses.values()]; }
  subscribe(listener: (status: HubPeerStatus) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  subscribeStatus(listener: (status: HubPeerStatus) => void): () => void { return this.subscribe(listener); }
  subscribeFrames(listener: (peerId: string, frame: FleetProtocolFrame) => void): () => void { this.frameListeners.add(listener); return () => this.frameListeners.delete(listener); }
  send(peerId: string, frame: FleetProtocolFrame): boolean {
    if (frame.kind !== 'request') return false;
    return this.connections.get(peerId)?.connection.sendFrame?.(frame) ?? false;
  }
  reconnect(peerId: string): boolean {
    const connection = this.connections.get(peerId)?.connection;
    if (connection === undefined) return false;
    connection.reconnect();
    return true;
  }
  markSynchronized(peerId: string): void { this.connections.get(peerId)?.connection.markSynchronized(); }
  markSyncing(peerId: string): void { this.connections.get(peerId)?.connection.markSyncing?.(); }
  requestCatalogSnapshot(peerId: string): string | undefined { return this.connections.get(peerId)?.connection.requestCatalogSnapshot?.(); }
  private create(peer: HubPeerRecord): ManagedHubPeerConnection {
    const connectionOptions: HubPeerConnectionOptions = {
      peer, local: this.options.local, scheduler: this.options.scheduler, random: this.options.random,
      dial: this.options.dial, requiredCapabilities: this.options.requiredCapabilities,
      onFrame: (frame) => { for (const listener of this.frameListeners) listener(peer.peerId, frame); this.options.onFrame(peer.peerId, frame); },
      onStatus: (status) => { this.statuses.set(status.peerId, status); for (const listener of this.listeners) listener(status); },
      onNegotiated: this.options.recordNegotiation,
    };
    return this.options.createConnection?.(connectionOptions) ?? new HubPeerConnection(connectionOptions);
  }
  private changed(previous: HubPeerRecord, current: HubPeerRecord): boolean { return previous.url !== current.url || previous.transportMode !== current.transportMode || previous.pinnedPublicKey !== current.pinnedPublicKey; }
}
