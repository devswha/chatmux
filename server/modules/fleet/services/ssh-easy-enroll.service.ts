import { FleetHubPairingError } from '@/modules/fleet/services/fleet-hub-pairing.service.js';
import { SshEnrollmentError, type PreparedSshTunnel, type SshTunnelManager } from '@/modules/fleet/services/ssh-tunnel.service.js';

export type SshEnrollmentInput = Readonly<{ sshTarget: string; password?: string; label?: string }>;
type Dependencies = Readonly<{
  tunnels: SshTunnelManager;
  hubPairing: Readonly<{ enroll(input: Readonly<{ peerUrl: string; transportMode: 'ssh-loopback'; token: string; label?: string }>): Promise<Readonly<{ peerId: string }>> }>;
}>;

export class SshEasyEnrollService {
  constructor(private readonly dependencies: Dependencies) {}

  async enroll(input: SshEnrollmentInput): Promise<Readonly<{ peerId: string; port: number }>> {
    let prepared: PreparedSshTunnel;
    try {
      prepared = await this.dependencies.tunnels.prepare({
        sshTarget: input.sshTarget,
        ...(input.password === undefined ? {} : { password: input.password }),
      });
    } catch (error) {
      if (error instanceof SshEnrollmentError) throw error;
      if (error instanceof Error) throw new SshEnrollmentError('TUNNEL_FAILED', 'SSH tunnel setup failed');
      throw error;
    }
    try {
      const peer = await this.dependencies.hubPairing.enroll({
        peerUrl: `ws://127.0.0.1:${prepared.localPort}/fleet-ws`,
        transportMode: 'ssh-loopback',
        token: prepared.token,
        ...(input.label === undefined ? {} : { label: input.label }),
      });
      prepared.complete(peer.peerId);
      return { peerId: peer.peerId, port: prepared.localPort };
    } catch (error) {
      prepared.abort();
      if (error instanceof FleetHubPairingError && error.code === 'PEER_CAPACITY_REACHED') {
        throw new SshEnrollmentError('PEER_LIMIT_REACHED', 'Fleet peer limit reached');
      }
      if (error instanceof Error) throw new SshEnrollmentError('ENROLL_FAILED', 'Fleet peer enrollment failed');
      throw error;
    }
  }

  async remove(peerId: string): Promise<void> {
    try { await this.dependencies.tunnels.remove(peerId); }
    catch (error) {
      if (!(error instanceof Error)) throw error;
      // Remote key cleanup is best-effort after durable peer revocation.
    }
  }
}
