import type {
  FleetCapability,
  FleetEventEnvelope,
  FleetRequestEnvelope,
  FleetResponseEnvelope,
} from '../../../../shared/fleet.js';

import type {
  FleetChallengeReplayGuard,
  FleetIdentitySigner,
  FleetPeerTrustStore,
} from './auth.js';
import type { FleetWritableTransport, FleetWriterOptions } from './bounded-writer.js';
import type { FleetProtocolErrorCode } from './errors.js';
import type { FleetConnectionRegistry } from './state-machine.js';
import type { FleetAuthRole, FleetHelloFrame, FleetTransportMode } from './types.js';

export interface FleetScheduledTask { cancel(): void; }
export interface FleetProtocolScheduler {
  now(): number;
  schedule(delayMs: number, callback: () => void): FleetScheduledTask;
}

export type FleetLocalEndpoint = Readonly<{
  readonly role: FleetAuthRole;
  readonly signer: FleetIdentitySigner;
  readonly processEpoch: string;
  readonly capabilities: readonly FleetCapability[];
  readonly transportMode: FleetTransportMode;
}>;

export type FleetProtocolConnectionOptions = Readonly<{
  readonly local: FleetLocalEndpoint;
  readonly trust: FleetPeerTrustStore;
  readonly replayGuard: FleetChallengeReplayGuard;
  readonly registry: FleetConnectionRegistry;
  readonly transport: FleetWritableTransport;
  readonly dispatch: (request: FleetRequestEnvelope) => Promise<FleetResponseEnvelope>;
  readonly onEvent?: (event: FleetEventEnvelope) => void;
  readonly onAuthenticated?: (connection: FleetAuthenticatedConnection) => void;
  readonly onResponse?: (response: FleetResponseEnvelope) => void;
  readonly onError?: (code: FleetProtocolErrorCode, detail?: string) => void;
  readonly scheduler?: FleetProtocolScheduler;
  readonly writer?: FleetWriterOptions;
  readonly requestCapacity?: number;
  readonly createHello?: (connectionId: string) => FleetHelloFrame;
}>;

export type FleetAwaitingProof = Readonly<{
  readonly kind: 'awaiting_proof';
  readonly remoteHello: FleetHelloFrame;
  readonly pinnedPublicKey: string;
  readonly challenge: Uint8Array;
  readonly challengeId: string;
  readonly capabilities: readonly FleetCapability[];
}>;

export type FleetAuthenticatedConnection = Readonly<{
  readonly kind: 'authenticated';
  readonly remoteInstallationId: string;
  readonly generation: number;
  readonly capabilities: readonly FleetCapability[];
  readonly lease: import('./state-machine.js').FleetHeartbeatLease;
}>;

export type FleetConnectionState =
  | Readonly<{ readonly kind: 'awaiting_hello' }>
  | FleetAwaitingProof
  | FleetAuthenticatedConnection
  | Readonly<{ readonly kind: 'closed' }>;
