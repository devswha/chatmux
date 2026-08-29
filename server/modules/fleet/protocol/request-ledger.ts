import type { FleetRequestEnvelope, FleetResponseEnvelope } from '../../../../shared/fleet.js';

import { canonicalFleetJson } from './codec.js';

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
        this.entries.set(request.requestId, { kind: 'complete', value: { canonicalRequest, response } });
        current.value.resolve(response);
      },
    };
  }

  get size(): number {
    return this.entries.size;
  }
}
