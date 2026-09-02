import type { FleetOperation, FleetRequestEnvelope, FleetResponseEnvelope } from '../../../../shared/fleet.js';

import { canonicalFleetJson } from './codec.js';

/**
 * Operations whose results the ledger keeps after completion, so a hub retry
 * with the same request id replays the recorded outcome instead of acting
 * twice. The RFC requires at-most-once delivery, and retention of at most
 * 4,096 results, for mutations only. Reads and the lease-bound terminal
 * stream (attach, per-keystroke input, resize) are coalesced while in flight
 * but evicted on completion: retaining them would exhaust the ledger after a
 * few thousand keystrokes and refuse every later mutation on the connection.
 */
const RETAINED_OPERATIONS: ReadonlySet<FleetOperation> = new Set<FleetOperation>([
  'chat.send', 'chat.abort',
  'prompt.respond', 'approval.respond',
  'pane.interrupt', 'pane.escape', 'pane.terminate', 'process.terminate',
  'session.spawn', 'session.terminate',
]);

export function isRetainedFleetOperation(operation: FleetOperation): boolean {
  return RETAINED_OPERATIONS.has(operation);
}

type PendingEntry = Readonly<{
  readonly canonicalRequest: string;
  readonly response: Promise<FleetResponseEnvelope>;
  readonly resolve: (response: FleetResponseEnvelope) => void;
}>;

type CompleteEntry = Readonly<{
  readonly canonicalRequest: string;
  readonly response: FleetResponseEnvelope;
}>;

type LedgerEntry =
  | Readonly<{ readonly kind: 'pending'; readonly value: PendingEntry }>
  | Readonly<{ readonly kind: 'complete'; readonly value: CompleteEntry }>;

export type FleetRequestAdmission =
  | Readonly<{
    readonly kind: 'dispatch';
    readonly complete: (response: FleetResponseEnvelope) => void;
  }>
  | Readonly<{ readonly kind: 'pending'; readonly response: Promise<FleetResponseEnvelope> }>
  | Readonly<{ readonly kind: 'replay'; readonly response: FleetResponseEnvelope }>
  | Readonly<{ readonly kind: 'conflict' }>
  | Readonly<{ readonly kind: 'full' }>;

export class FleetRequestLedger {
  private readonly entries = new Map<string, LedgerEntry>();

  constructor(private readonly capacity = 4_096) {}

  admit(request: FleetRequestEnvelope): FleetRequestAdmission {
    const canonicalRequest = canonicalFleetJson(request);
    const existing = this.entries.get(request.requestId);
    if (existing !== undefined) {
      if (existing.value.canonicalRequest !== canonicalRequest) return { kind: 'conflict' };
      switch (existing.kind) {
        case 'pending': return { kind: 'pending', response: existing.value.response };
        case 'complete': return { kind: 'replay', response: existing.value.response };
      }
    }
    if (this.entries.size >= this.capacity) return { kind: 'full' };
    const deferred = Promise.withResolvers<FleetResponseEnvelope>();
    this.entries.set(request.requestId, {
      kind: 'pending',
      value: { canonicalRequest, response: deferred.promise, resolve: deferred.resolve },
    });
    return {
      kind: 'dispatch',
      complete: (response) => {
        const current = this.entries.get(request.requestId);
        if (current?.kind !== 'pending' || current.value.canonicalRequest !== canonicalRequest) return;
        if (isRetainedFleetOperation(request.operation)) {
          this.entries.set(request.requestId, { kind: 'complete', value: { canonicalRequest, response } });
        } else {
          this.entries.delete(request.requestId);
        }
        current.value.resolve(response);
      },
    };
  }

  get size(): number {
    return this.entries.size;
  }
}
