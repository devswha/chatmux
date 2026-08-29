import { isLoopbackAddress } from '../../../tailscale-auth.js';

export type FleetOwnerAuthorizationInput = Readonly<{
  authMode: 'none' | 'password' | 'tailscale';
  principal: Readonly<{ id?: number; tailscaleRole?: string }> | null | undefined;
  remoteAddress: string | null | undefined;
}>;

export type FleetOwnerAuthorization =
  | Readonly<{ authorized: true }>
  | Readonly<{ authorized: false; reason: 'owner_required' }>;

const AUTHORIZED = { authorized: true } as const;
const DENIED = { authorized: false, reason: 'owner_required' } as const;

export function authorizeFleetOwner(input: FleetOwnerAuthorizationInput): FleetOwnerAuthorization {
  switch (input.authMode) {
    case 'password':
      return typeof input.principal?.id === 'number' ? AUTHORIZED : DENIED;
    case 'tailscale':
      return input.principal?.tailscaleRole === 'owner' || input.principal?.tailscaleRole === 'local'
        ? AUTHORIZED
        : DENIED;
    case 'none':
      return input.principal && isLoopbackAddress(input.remoteAddress) ? AUTHORIZED : DENIED;
  }
}
