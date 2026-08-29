import type { FleetPairingTransportMode } from '@/modules/fleet/services/fleet-hub-pairing.service.js';
import type { SignedInstallationIdentity } from '@/modules/fleet/services/fleet-pairing.service.js';

type RevocablePeer = Readonly<{
  peerId: string;
  url: string;
  transportMode: FleetPairingTransportMode;
  enrollmentState: 'enrolled' | 'revoked';
}>;
interface RevocationPeerRegistry {
  find(peerId: string): RevocablePeer | undefined;
  revoke(peerId: string, nowMs: number): RevocablePeer | undefined;
}
interface FleetRevocationTransport {
  revoke(request: Readonly<{ peer: RevocablePeer; hub: SignedInstallationIdentity }>): Promise<boolean>;
}
type RevocationDependencies = Readonly<{
  identity: SignedInstallationIdentity;
  peers: RevocationPeerRegistry;
  transport: FleetRevocationTransport;
  now?: () => number;
}>;
export type FleetRemovalResult = Readonly<{
  localRemoval: 'removed' | 'not_found' | 'already_removed';
  peerRevocation: 'revoked' | 'refused' | 'unreachable' | 'not_attempted';
}>;

export class FleetRevocationService {
  constructor(private readonly dependencies: RevocationDependencies) {}

  async remove(peerId: string): Promise<FleetRemovalResult> {
    const peer = this.dependencies.peers.find(peerId);
    if (peer === undefined) return { localRemoval: 'not_found', peerRevocation: 'not_attempted' };
    if (peer.enrollmentState === 'revoked') {
      return { localRemoval: 'already_removed', peerRevocation: 'not_attempted' };
    }
    const removed = this.dependencies.peers.revoke(
      peerId,
      this.dependencies.now?.() ?? Date.now(),
    );
    if (removed === undefined) {
      return { localRemoval: 'not_found', peerRevocation: 'not_attempted' };
    }
    let peerRevocation: FleetRemovalResult['peerRevocation'];
    try {
      peerRevocation = await this.dependencies.transport.revoke({
        peer,
        hub: this.dependencies.identity,
      }) ? 'revoked' : 'refused';
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      peerRevocation = 'unreachable';
    }
    return { localRemoval: 'removed', peerRevocation };
  }
}
