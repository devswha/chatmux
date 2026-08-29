export type FleetProtocolErrorCode =
  | 'AUTH_DEADLINE_EXCEEDED'
  | 'AUTH_TRANSCRIPT_MISMATCH'
  | 'AUTH_SIGNATURE_INVALID'
  | 'AUTH_REPLAYED'
  | 'AUTH_PEER_UNAUTHORIZED'
  | 'PROTOCOL_FRAME_INVALID'
  | 'PROTOCOL_FRAME_TOO_LARGE'
  | 'PROTOCOL_QUEUE_FULL'
  | 'PROTOCOL_LEASE_EXPIRED'
  | 'PROTOCOL_STALE_GENERATION';

export class FleetProtocolError extends Error {
  readonly name = 'FleetProtocolError';

  constructor(
    readonly code: FleetProtocolErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}
