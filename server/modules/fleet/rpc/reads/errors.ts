import type { FleetErrorCode } from '../../../../../shared/fleet.js';

export class FleetReadRpcError extends Error {
  readonly name = 'FleetReadRpcError';
  constructor(readonly code: Extract<FleetErrorCode,
    'FLEET_MALFORMED_FRAME' | 'FLEET_DEADLINE_EXCEEDED' | 'FLEET_CAPABILITY_UNAVAILABLE' | 'HOST_NOT_FOUND'
  >, message: string) { super(message); }
}
