import type { FleetOperation, FleetRequestEnvelope, FleetResponseEnvelope } from '../../../../shared/fleet.js';

import { canonicalFleetJson } from './codec.js';

type PendingEntry = Readonly<{
  readonly canonicalRequest: string;
  readonly response: Promise<FleetResponseEnvelope>;
  readonly resolve: (response: FleetResponseEnvelope) => void;
}>;

type CompleteEntry = Readonly<{
  readonly canonicalRequest: string;
  readonly response: FleetResponseEnvelope;
  readonly replaySafe: boolean;
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

const REPLAY_SAFE_OPERATIONS: ReadonlySet<FleetOperation> = new Set([
  'catalog.snapshot',
  'session.read',
  'session.history',
  'session.search',
  'prompt.read',
  'approval.read',
  'pane.capture',
]);

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
    if (this.entries.size >= this.capacity && !this.evictOldestReplaySafeEntry()) return { kind: 'full' };
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
        // Reinsert completed entries at the tail so bounded eviction follows
        // completion order without ever removing an in-flight request.
        this.entries.delete(request.requestId);
        this.entries.set(request.requestId, {
          kind: 'complete',
          value: { canonicalRequest, response, replaySafe: REPLAY_SAFE_OPERATIONS.has(request.operation) },
        });
        current.value.resolve(response);
      },
    };
  }

  private evictOldestReplaySafeEntry(): boolean {
    for (const [requestId, entry] of this.entries) {
      if (entry.kind !== 'complete' || !entry.value.replaySafe) continue;
      this.entries.delete(requestId);
      return true;
    }
    return false;
  }

  get size(): number {
    return this.entries.size;
  }
}
