import type { FleetErrorCode } from '../../../../../shared/fleet.js';

export class FleetMutationRpcError extends Error {
  readonly name = 'FleetMutationRpcError';
  constructor(readonly code: FleetErrorCode, message: string) { super(message); }
}
