import type { FleetCapability, FleetPeerState, FleetProtocolVersion } from '../../../../../shared/fleet.js';
import type { FleetIdentitySigner } from '../../protocol/auth.js';
import type { FleetProtocolFrame, FleetTransportMode } from '../../protocol/types.js';

export type HubPeerRecord = Readonly<{
  readonly peerId: string;
  readonly url: string;
  readonly transportMode: FleetTransportMode;
  readonly pinnedPublicKey: string;
  readonly enrollmentState: 'enrolled' | 'revoked';
}>;

export type HubPeerStatus = Readonly<{
  readonly peerId: string;
  readonly state: FleetPeerState;
  readonly protocolVersion: FleetProtocolVersion | null;
  readonly capabilities: readonly FleetCapability[];
  readonly peerProcessEpoch: string | null;
  readonly generation: number | null;
  readonly lastHeartbeatAtMs: number | null;
}>;

export interface HubScheduledTask { cancel(): void; }
export interface HubConnectionScheduler {
  readonly nowMs: number;
  schedule(delayMs: number, callback: () => void): HubScheduledTask;
}

export interface HubPeerSocket {
  onOpen(listener: () => void): void;
  onMessage(listener: (raw: Buffer) => void): void;
  onClose(listener: () => void): void;
  onError(listener: () => void): void;
  send(payload: string): void;
  close(code: number, reason: string): void;
}

export type HubLocalIdentity = Readonly<{
  readonly signer: FleetIdentitySigner;
  readonly processEpoch: string;
  readonly capabilities: readonly FleetCapability[];
}>;

export type HubPeerConnectionOptions = Readonly<{
  readonly peer: HubPeerRecord;
  readonly local: HubLocalIdentity;
  readonly requiredCapabilities?: readonly FleetCapability[];
  readonly scheduler: HubConnectionScheduler;
  readonly random: () => number;
  readonly dial: (target: URL) => HubPeerSocket;
  readonly onStatus: (status: HubPeerStatus) => void;
  readonly onFrame: (frame: FleetProtocolFrame) => void;
  readonly onNegotiated?: (status: HubPeerStatus) => void;
}>;
