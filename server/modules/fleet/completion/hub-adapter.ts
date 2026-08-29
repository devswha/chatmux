import {
  FleetCompletionParseError,
  parseFleetCompletionReady,
  type FleetCompletionReady,
} from '../../../../shared/fleet-completion.js';
import type { FleetCapability, FleetPeerState } from '../../../../shared/fleet.js';

export type FleetCompletionAcceptance = 'created' | 'replay' | 'ignored';

type CompletionPeerStatus = Readonly<{
  readonly state: FleetPeerState;
  readonly capabilities: readonly FleetCapability[];
}>;

type CompletionDecision = Readonly<{
  readonly kind: FleetCompletionAcceptance;
  readonly decisionIds: readonly number[];
}>;

type FleetCompletionHubDependencies = Readonly<{
  readonly status: (hostId: string) => CompletionPeerStatus | undefined;
  readonly hostLabel: (hostId: string) => string | undefined;
  readonly ownerId: () => number | null;
  readonly record: (ownerId: number, event: FleetCompletionReady, now: number) => CompletionDecision;
  readonly wake: () => void;
  readonly now?: () => number;
}>;

export function createFleetCompletionHubAdapter(deps: FleetCompletionHubDependencies): Readonly<{
  readonly accept: (sourceHostId: string, body: unknown) => FleetCompletionAcceptance;
}> {
  return {
    accept(sourceHostId, body) {
      const status = deps.status(sourceHostId);
      if (status?.state !== 'online' || !status.capabilities.includes('completion.event')) return 'ignored';
      const ownerId = deps.ownerId();
      const trustedLabel = deps.hostLabel(sourceHostId);
      if (ownerId === null || trustedLabel === undefined) return 'ignored';
      let event: FleetCompletionReady;
      try {
        event = parseFleetCompletionReady(body);
      } catch (error) {
        if (error instanceof FleetCompletionParseError) return 'ignored';
        throw error;
      }
      if (event.target.hostId !== sourceHostId) return 'ignored';
      const decision = deps.record(ownerId, { ...event, hostLabel: trustedLabel }, deps.now?.() ?? Date.now());
      if (decision.kind === 'created' && decision.decisionIds.length > 0) deps.wake();
      return decision.kind;
    },
  };
}
