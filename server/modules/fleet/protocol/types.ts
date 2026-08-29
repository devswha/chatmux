import type {
  FleetCapability,
  FleetEventEnvelope,
  FleetProtocolVersion,
  FleetRequestEnvelope,
  FleetResponseEnvelope,
} from '../../../../shared/fleet.js';

export const FLEET_TRANSPORT_MODES = ['direct-wss', 'ssh-loopback'] as const;
export const FLEET_AUTH_ROLES = ['hub', 'peer'] as const;
export const FLEET_AUTH_DEADLINE_MS = 5_000 as const;
export const FLEET_HEARTBEAT_INTERVAL_MS = 10_000 as const;
export const FLEET_LEASE_MS = 30_000 as const;

export type FleetTransportMode = typeof FLEET_TRANSPORT_MODES[number];
export type FleetAuthRole = typeof FLEET_AUTH_ROLES[number];

export type FleetHelloFrame = Readonly<{
  readonly kind: 'auth.hello';
  readonly role: FleetAuthRole;
  readonly installationId: string;
  readonly processEpoch: string;
  readonly connectionId: string;
  readonly nonce: string;
  readonly protocolVersions: readonly FleetProtocolVersion[];
  readonly capabilities: readonly FleetCapability[];
  readonly transportMode: FleetTransportMode;
}>;

export type FleetProofFrame = Readonly<{
  readonly kind: 'auth.proof';
  readonly role: FleetAuthRole;
  readonly installationId: string;
  readonly connectionId: string;
  readonly signature: string;
}>;

export type FleetHeartbeatFrame = Readonly<{
  readonly kind: 'heartbeat';
  readonly connectionGeneration: number;
  readonly sentAtMs: number;
}>;

export type FleetProtocolFrame =
  | FleetHelloFrame
  | FleetProofFrame
  | FleetHeartbeatFrame
  | FleetRequestEnvelope
  | FleetResponseEnvelope
  | FleetEventEnvelope;
