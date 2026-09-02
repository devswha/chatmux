/**
 * Lets the owner's revoke routes reach the live peer endpoint without a
 * module dependency in that direction: the settings router is composed at
 * startup, the peer runtime only when fleet is enabled and started.
 */
class FleetPeerRevocationGateway {
  private handler: (() => void) | undefined;

  bind(handler: () => void): void {
    this.handler = handler;
  }

  unbind(handler: () => void): void {
    if (this.handler === handler) this.handler = undefined;
  }

  /** Closes every live hub connection; a no-op while no peer runtime is bound. */
  notifyRevoked(): boolean {
    if (this.handler === undefined) return false;
    this.handler();
    return true;
  }
}

export const fleetPeerRevocationGateway = new FleetPeerRevocationGateway();
