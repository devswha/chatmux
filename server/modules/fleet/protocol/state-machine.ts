import { FleetProtocolError } from './errors.js';
import { FLEET_HEARTBEAT_INTERVAL_MS, FLEET_LEASE_MS } from './types.js';

export interface FleetGenerationStore {
  claimNext(peerInstallationId: string): Promise<number>;
}

export interface FleetSupersedableConnection {
  close(code: number, reason: string): void;
}

type ActiveConnection = Readonly<{
  readonly generation: number;
  readonly connection: FleetSupersedableConnection;
}>;

export class FleetConnectionRegistry {
  private readonly active = new Map<string, ActiveConnection>();

  constructor(private readonly generations: FleetGenerationStore) {}

  async activate(peerInstallationId: string, connection: FleetSupersedableConnection): Promise<number> {
    const generation = await this.generations.claimNext(peerInstallationId);
    const current = this.active.get(peerInstallationId);
    if (current !== undefined && current.generation >= generation) {
      connection.close(4001, 'fleet connection superseded');
      throw new FleetProtocolError('PROTOCOL_STALE_GENERATION', 'connection generation is stale');
    }
    current?.connection.close(4001, 'fleet connection superseded');
    this.active.set(peerInstallationId, { generation, connection });
    return generation;
  }

  assertCurrent(peerInstallationId: string, generation: number): void {
    if (this.active.get(peerInstallationId)?.generation !== generation) {
      throw new FleetProtocolError('PROTOCOL_STALE_GENERATION', 'connection generation is stale');
    }
  }

  release(peerInstallationId: string, generation: number): void {
    if (this.active.get(peerInstallationId)?.generation === generation) {
      this.active.delete(peerInstallationId);
    }
  }
}

export type FleetLeasePoll =
  | Readonly<{ readonly kind: 'healthy' }>
  | Readonly<{ readonly kind: 'heartbeat_due' }>
  | Readonly<{ readonly kind: 'expired' }>;

export class FleetHeartbeatLease {
  private lastReceivedAtMs: number;
  private lastSentAtMs: number;

  constructor(startedAtMs: number) {
    this.lastReceivedAtMs = startedAtMs;
    this.lastSentAtMs = startedAtMs;
  }

  received(nowMs: number): void {
    this.lastReceivedAtMs = nowMs;
  }

  markSent(nowMs: number): void {
    this.lastSentAtMs = nowMs;
  }

  poll(nowMs: number): FleetLeasePoll {
    if (nowMs - this.lastReceivedAtMs >= FLEET_LEASE_MS) return { kind: 'expired' };
    if (nowMs - this.lastSentAtMs >= FLEET_HEARTBEAT_INTERVAL_MS) return { kind: 'heartbeat_due' };
    return { kind: 'healthy' };
  }
}
