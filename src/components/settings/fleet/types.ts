import type { FleetCapability, FleetPeerState, FleetProtocolVersion } from '../../../../shared/fleet';

export type FleetTransportMode = 'direct-wss' | 'ssh-loopback';

export type FleetSettingsPeer = Readonly<{
  readonly peerId: string;
  readonly displayLabel: string;
  readonly transportMode: FleetTransportMode;
  readonly enrollmentState: 'enrolled' | 'revoked';
  readonly state: FleetPeerState;
  readonly protocolVersion: FleetProtocolVersion | null;
  readonly capabilities: readonly FleetCapability[];
  readonly lastSeenAtMs: number | null;
  readonly peerFingerprint: string;
}>;

export type FleetSettingsPayload = Readonly<{
  readonly local: Readonly<{
    readonly installationId: string;
    readonly publicKeyFingerprint: string;
  }>;
  readonly role: 'standalone' | 'hub' | 'peer';
  readonly capacity: Readonly<{
    readonly totalInstallations: number;
    readonly remotePeers: number;
  }>;
  readonly peers: readonly FleetSettingsPeer[];
}>;

export type FleetPairingCode = Readonly<{
  readonly token: string;
  readonly expiresAtMs: number;
}>;

export type FleetEnrollmentInput = Readonly<{
  readonly peerUrl: string;
  readonly transportMode: FleetTransportMode;
  readonly token: string;
  readonly label: string;
}>;

export { FLEET_SSH_ENROLLMENT_ERROR_CODES } from '../../../../shared/fleet-ssh';
export type {
  FleetSshCandidate, FleetSshCandidatesPayload, FleetSshEnrollmentErrorCode,
  FleetSshEnrollmentErrorDetails, FleetSshEnrollmentInput, FleetSshEnrollmentResult,
} from '../../../../shared/fleet-ssh';

export type FleetRevocationResult = Readonly<{
  readonly localRemoval: 'removed' | 'not_found' | 'already_removed';
  readonly peerRevocation: 'revoked' | 'refused' | 'unreachable' | 'not_attempted';
}>;
