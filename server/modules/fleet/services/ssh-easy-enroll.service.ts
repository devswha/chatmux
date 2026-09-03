import { FleetHubPairingError } from '@/modules/fleet/services/fleet-hub-pairing.service.js';
import { SshEnrollmentError, type PreparedSshTunnel, type SshTunnelManager } from '@/modules/fleet/services/ssh-tunnel.service.js';

export type SshEnrollmentInput = Readonly<{ sshTarget: string; password?: string; label?: string }>;
type HubInput = Readonly<{ peerUrl: string; transportMode: 'ssh-loopback'; token: string; label?: string }>;
type Dependencies = Readonly<{
  tunnels: SshTunnelManager;
  onPersisted?: () => void;
  hubPairing: Readonly<{
    preflight?(input: Pick<HubInput, 'peerUrl' | 'transportMode'>): void;
    enroll(input: HubInput): Promise<Readonly<{ peerId: string }>>;
    rollback?(peerId: string): Promise<void> | void;
  }>;
}>;

export class SshEasyEnrollService {
  constructor(private readonly dependencies: Dependencies) {}

  async enroll(input: SshEnrollmentInput): Promise<Readonly<{ peerId: string; port: number }>> {
    // Capacity and role checks happen before key installation. The placeholder
    // loopback port is policy-equivalent; final checks still run during enroll.
    try { this.dependencies.hubPairing.preflight?.({ peerUrl: 'ws://127.0.0.1:1/fleet-ws', transportMode: 'ssh-loopback' }); }
    catch (error) { throw this.closedPairingError(error); }

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
    let peerId: string | undefined;
    try {
      const peer = await this.dependencies.hubPairing.enroll({
        peerUrl: `ws://127.0.0.1:${prepared.localPort}/fleet-ws`,
        transportMode: 'ssh-loopback',
        token: prepared.token,
        ...(input.label === undefined ? {} : { label: input.label }),
      });
      peerId = peer.peerId;
      prepared.complete(peer.peerId);
      this.dependencies.onPersisted?.();
      return { peerId: peer.peerId, port: prepared.localPort };
    } catch (error) {
      const cleanupErrors: Error[] = [];
      // Revoke remote and local grants while the forward is still usable. Tunnel
      // teardown follows even when either compensation boundary fails.
      if (peerId !== undefined) {
        try { await this.dependencies.hubPairing.rollback?.(peerId); }
        catch (rollbackError) { cleanupErrors.push(rollbackError instanceof Error ? rollbackError : new Error('pairing rollback failed')); }
      }
      try { await prepared.abort(); }
      catch (abortError) { cleanupErrors.push(abortError instanceof Error ? abortError : new Error('SSH cleanup failed')); }
      const closed = this.closedPairingError(error);
      if (cleanupErrors.length > 0) throw new SshEnrollmentError(closed.code, `${closed.message}; cleanup was incomplete`, cleanupErrors);
      throw closed;
    }
  }

  async remove(peerId: string): Promise<void> {
    try { await this.dependencies.tunnels.remove(peerId); }
    catch (error) {
      if (!(error instanceof Error)) throw error;
      // Remote key cleanup is best-effort after durable peer revocation.
    }
  }

  private closedPairingError(error: unknown): SshEnrollmentError {
    if (error instanceof FleetHubPairingError && error.code === 'PEER_CAPACITY_REACHED') {
      return new SshEnrollmentError('PEER_LIMIT_REACHED', 'Fleet peer limit reached');
    }
    if (error instanceof SshEnrollmentError) return error;
    return new SshEnrollmentError('ENROLL_FAILED', 'Fleet peer enrollment failed');
  }
}
