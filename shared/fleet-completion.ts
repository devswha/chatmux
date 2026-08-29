import { createHash } from 'node:crypto';

export const FLEET_COMPLETION_VERSION = 'completion/1' as const;

export type FleetCompletionAppTarget = Readonly<{
  readonly kind: 'app';
  readonly hostId: string;
  readonly localId: string;
}>;

export type FleetCompletionPaneGenerationTarget = Readonly<{
  readonly kind: 'pane_generation';
  readonly hostId: string;
  readonly lane: 'external' | 'live';
  readonly appLocalId: string | null;
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

export type FleetCompletionTarget = FleetCompletionAppTarget | FleetCompletionPaneGenerationTarget;

export type FleetCompletionReady = Readonly<{
  readonly version: typeof FLEET_COMPLETION_VERSION;
  readonly target: FleetCompletionTarget;
  readonly provider: string;
  readonly occurrenceKey: string;
  readonly preferenceClass: 'stop' | 'liveStop';
  readonly hostLabel: string;
  readonly sessionLabel: string | null;
}>;

const HOST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_ID = 256;
const MAX_LABEL = 80;

export class FleetCompletionParseError extends TypeError {
  readonly name = 'FleetCompletionParseError';
}

function fail(message: string): never {
  throw new FleetCompletionParseError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function object(value: unknown, name: string): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) fail(`${name} must be an object`);
  return value;
}

function exact(value: Readonly<Record<string, unknown>>, keys: readonly string[], name: string): void {
  if (Object.keys(value).length !== keys.length || Object.keys(value).some((key) => !keys.includes(key))) {
    fail(`${name} has unexpected fields`);
  }
}

function text(value: unknown, name: string, max = MAX_ID): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || value.includes('\0') || /[\uD800-\uDFFF]/.test(value)) {
    fail(`${name} is invalid`);
  }
  return value;
}

function positiveInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) fail(`${name} is invalid`);
  return value;
}

function parseTarget(value: unknown): FleetCompletionTarget {
  const input = object(value, 'target');
  if (input.kind === 'app') {
    exact(input, ['kind', 'hostId', 'localId'], 'app target');
    const parsedHostId = text(input.hostId, 'hostId');
    if (!HOST_ID.test(parsedHostId)) fail('hostId is invalid');
    return { kind: 'app', hostId: parsedHostId, localId: text(input.localId, 'localId') };
  }
  if (input.kind !== 'pane_generation') fail('target kind is invalid');
  exact(input, ['kind', 'hostId', 'lane', 'appLocalId', 'tmux', 'process'], 'pane generation target');
  const parsedHostId = text(input.hostId, 'hostId');
  if (!HOST_ID.test(parsedHostId)) fail('hostId is invalid');
  if (input.lane !== 'external' && input.lane !== 'live') fail('lane is invalid');
  const tmux = object(input.tmux, 'tmux');
  exact(tmux, ['sessionId', 'windowId', 'paneId'], 'tmux');
  const process = object(input.process, 'process');
  exact(process, ['pid', 'startedAtMs'], 'process');
  return {
    kind: 'pane_generation', hostId: parsedHostId, lane: input.lane,
    appLocalId: input.appLocalId === null ? null : text(input.appLocalId, 'appLocalId'),
    tmux: {
      sessionId: text(tmux.sessionId, 'tmux.sessionId'),
      windowId: text(tmux.windowId, 'tmux.windowId'),
      paneId: text(tmux.paneId, 'tmux.paneId'),
    },
    process: {
      pid: positiveInteger(process.pid, 'process.pid'),
      startedAtMs: positiveInteger(process.startedAtMs, 'process.startedAtMs'),
    },
  };
}

export function parseFleetCompletionReady(value: unknown): FleetCompletionReady {
  const input = object(value, 'completion event');
  exact(input, ['version', 'target', 'provider', 'occurrenceKey', 'preferenceClass', 'hostLabel', 'sessionLabel'], 'completion event');
  if (input.version !== FLEET_COMPLETION_VERSION) fail('completion version is invalid');
  if (input.preferenceClass !== 'stop' && input.preferenceClass !== 'liveStop') fail('preferenceClass is invalid');
  return {
    version: FLEET_COMPLETION_VERSION,
    target: parseTarget(input.target),
    provider: text(input.provider, 'provider'),
    occurrenceKey: text(input.occurrenceKey, 'occurrenceKey'),
    preferenceClass: input.preferenceClass,
    hostLabel: text(input.hostLabel, 'hostLabel', MAX_LABEL),
    sessionLabel: input.sessionLabel === null ? null : text(input.sessionLabel, 'sessionLabel', MAX_LABEL),
  };
}

function digest(domain: string, fields: readonly string[]): string {
  const hash = createHash('sha256');
  for (const field of [FLEET_COMPLETION_VERSION, domain, ...fields]) {
    const bytes = Buffer.from(field, 'utf8');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    hash.update(length).update(bytes);
  }
  return `completion-target/v2:${domain}:${hash.digest('hex')}`;
}

export function completionEventIdentityKey(event: FleetCompletionReady): string {
  switch (event.target.kind) {
    case 'app':
      return digest('app', [event.target.hostId, event.provider, event.target.localId]);
    case 'pane_generation':
      return digest('pane_generation', [
        event.target.hostId, event.target.lane, event.provider,
        event.target.tmux.sessionId, event.target.tmux.windowId, event.target.tmux.paneId,
        String(event.target.process.pid), String(event.target.process.startedAtMs),
      ]);
  }
}
