import type { AuthMode, AuthUser } from '../../auth/types';

export function isFleetOwner(authMode: AuthMode | null, user: AuthUser | null): boolean {
  if (user === null || authMode === null) return false;
  switch (authMode) {
    case 'none':
    case 'password':
      return true;
    case 'tailscale':
      return user.tailscaleRole === 'owner' || user.tailscaleRole === 'local';
  }
}
