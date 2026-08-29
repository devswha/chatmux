import {
  FLEET_COMPLETION_VERSION,
  parseFleetCompletionReady,
  type FleetCompletionReady,
} from '../../../../shared/fleet-completion.js';

export type AppCompletionInput = Readonly<{
  readonly provider: string;
  readonly localId: string;
  readonly occurrenceKey: string;
  readonly sessionLabel: string | null;
}>;

export type PaneCompletionInput = Readonly<{
  readonly provider: string;
  readonly lane: 'external' | 'live';
  readonly appLocalId: string | null;
  readonly occurrenceKey: string;
  readonly sessionLabel: string | null;
  readonly tmux: Readonly<{
    readonly sessionId: string;
    readonly windowId: string;
    readonly paneId: string;
  }>;
  readonly process: Readonly<{
    readonly pid: number;
    readonly startedAtMs: number;
  }>;
}>;

type CompletionSink = (event: FleetCompletionReady) => void;

export class FleetCompletionPeerPublisher {
  private readonly sinks = new Set<CompletionSink>();

  constructor(
    private readonly hostId: string,
    private readonly hostLabel: string,
  ) {}

  subscribe(sink: CompletionSink): () => void {
    this.sinks.add(sink);
    return () => this.sinks.delete(sink);
  }

  app(input: AppCompletionInput): void {
    this.publish(parseFleetCompletionReady({
      version: FLEET_COMPLETION_VERSION,
      target: { kind: 'app', hostId: this.hostId, localId: input.localId },
      provider: input.provider, occurrenceKey: input.occurrenceKey, preferenceClass: 'stop',
      hostLabel: this.hostLabel, sessionLabel: input.sessionLabel,
    }));
  }

  pane(input: PaneCompletionInput): void {
    this.publish(parseFleetCompletionReady({
      version: FLEET_COMPLETION_VERSION,
      target: {
        kind: 'pane_generation', hostId: this.hostId, lane: input.lane,
        appLocalId: input.appLocalId, tmux: input.tmux, process: input.process,
      },
      provider: input.provider, occurrenceKey: input.occurrenceKey, preferenceClass: 'liveStop',
      hostLabel: this.hostLabel, sessionLabel: input.sessionLabel,
    }));
  }

  private publish(event: FleetCompletionReady): void {
    for (const sink of this.sinks) sink(event);
  }
}

class FleetCompletionPeerGateway {
  private publisher: FleetCompletionPeerPublisher | undefined;

  bind(publisher: FleetCompletionPeerPublisher): () => void {
    if (this.publisher !== undefined) throw new TypeError('fleet completion publisher is already bound');
    this.publisher = publisher;
    return () => {
      if (this.publisher === publisher) this.publisher = undefined;
    };
  }

  app(input: AppCompletionInput): void {
    this.publisher?.app(input);
  }

  pane(input: PaneCompletionInput): void {
    this.publisher?.pane(input);
  }
}

export const fleetCompletionPeerGateway = new FleetCompletionPeerGateway();
