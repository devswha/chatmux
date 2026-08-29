import type { FleetBrowserDiscovery } from './browser-discovery.js';

class FleetBrowserDiscoveryGateway {
  private authority: FleetBrowserDiscovery | undefined;

  bind(authority: FleetBrowserDiscovery): void {
    if (this.authority !== undefined) throw new TypeError('fleet browser discovery is already bound');
    this.authority = authority;
  }

  unbind(authority: FleetBrowserDiscovery): void {
    if (this.authority !== authority) return;
    this.authority = undefined;
    authority.dispose();
  }

  current(): FleetBrowserDiscovery | undefined {
    return this.authority;
  }
}

export const fleetBrowserDiscoveryGateway = new FleetBrowserDiscoveryGateway();
