import type {
  FleetPaneReference,
  FleetProjectReference,
  FleetRequestEnvelope,
  FleetSessionReference,
  JsonValue,
} from '../../../../../shared/fleet.js';

export type SessionMetadataRead = Readonly<{ readonly read: 'metadata'; readonly deadlineAtMs: number }>;
export type ProviderInventoryRead = Readonly<{ readonly read: 'provider_inventory'; readonly deadlineAtMs: number }>;
export type ChatSubscriptionRead = Readonly<{
  readonly read: 'chat_subscription';
  readonly deadlineAtMs: number;
  readonly lastSeq: number;
}>;
export type HistoryRead = Readonly<{ readonly deadlineAtMs: number; readonly limit: number | null; readonly offset: number; readonly includeImages: boolean }>;
export type TranscriptSearchRead = Readonly<{ readonly read: 'transcript_search'; readonly deadlineAtMs: number; readonly query: string; readonly limit: number }>;
export type PathSuggestionsRead = Readonly<{ readonly read: 'path_suggestions'; readonly deadlineAtMs: number; readonly prefix: string }>;
export type PromptRead = Readonly<{ readonly deadlineAtMs: number }>;
export type PaneCaptureRead = PromptRead;

type RequestBase<TTarget, TBody> = Omit<FleetRequestEnvelope, 'operation' | 'target' | 'body'> & Readonly<{
  readonly target: TTarget;
  readonly body: TBody;
}>;

export type FleetReadRequest =
  | (RequestBase<FleetSessionReference, SessionMetadataRead | ProviderInventoryRead | ChatSubscriptionRead> & Readonly<{ readonly operation: 'session.read' }>)
  | (RequestBase<FleetSessionReference, HistoryRead> & Readonly<{ readonly operation: 'session.history' }>)
  | (RequestBase<FleetProjectReference, TranscriptSearchRead | PathSuggestionsRead> & Readonly<{ readonly operation: 'session.search' }>)
  | (RequestBase<FleetSessionReference, PromptRead> & Readonly<{ readonly operation: 'prompt.read' | 'approval.read' }>)
  | (RequestBase<FleetPaneReference, PaneCaptureRead> & Readonly<{ readonly operation: 'pane.capture' }>);

export const FLEET_READ_OPERATIONS = [
  'session.read', 'session.history', 'session.search',
  'prompt.read', 'approval.read', 'pane.capture',
] as const;

export class FleetReadContractError extends Error {
  readonly name = 'FleetReadContractError';
  constructor(message: string) { super(message); }
}

function fail(message: string): never { throw new FleetReadContractError(message); }
function isRecord(value: JsonValue): value is Readonly<Record<string, JsonValue>> {
  return value !== null && !Array.isArray(value) && typeof value === 'object';
}
function record(value: JsonValue): Readonly<Record<string, JsonValue>> {
  return isRecord(value) ? value : fail('read body must be an object');
}
function exact(value: Readonly<Record<string, JsonValue>>, fields: readonly string[]): void {
  const keys = Object.keys(value);
  if (keys.length !== fields.length || keys.some((key) => !fields.includes(key))) fail('read body has unexpected fields');
}
function deadline(value: JsonValue | undefined): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) return fail('deadlineAtMs is invalid');
  return value;
}
type Range = Readonly<{ readonly minimum: number; readonly maximum: number }>;
function integer(value: JsonValue | undefined, name: string, range: Range): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < range.minimum || value > range.maximum) return fail(`${name} is invalid`);
  return value;
}
function text(value: JsonValue | undefined, name: string, range: Range): string {
  if (typeof value !== 'string' || value.length < range.minimum || value.length > range.maximum || value.includes('\0')) return fail(`${name} is invalid`);
  return value;
}
function simple(body: JsonValue): PromptRead {
  const input = record(body); exact(input, ['deadlineAtMs']);
  return { deadlineAtMs: deadline(input.deadlineAtMs) };
}
function sessionRead(body: JsonValue): SessionMetadataRead | ProviderInventoryRead | ChatSubscriptionRead {
  const input = record(body);
  if (input.read === 'chat_subscription') {
    exact(input, ['read', 'deadlineAtMs', 'lastSeq']);
    return {
      read: input.read,
      deadlineAtMs: deadline(input.deadlineAtMs),
      lastSeq: integer(input.lastSeq, 'lastSeq', { minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    };
  }
  exact(input, ['read', 'deadlineAtMs']);
  if (input.read !== 'metadata' && input.read !== 'provider_inventory') return fail('session read kind is invalid');
  return { read: input.read, deadlineAtMs: deadline(input.deadlineAtMs) };
}
function history(body: JsonValue): HistoryRead {
  const input = record(body); exact(input, ['deadlineAtMs', 'limit', 'offset', 'includeImages']);
  const limit = input.limit === null ? null : integer(input.limit, 'limit', { minimum: 0, maximum: 500 });
  if (typeof input.includeImages !== 'boolean') return fail('includeImages is invalid');
  return { deadlineAtMs: deadline(input.deadlineAtMs), limit, offset: integer(input.offset, 'offset', { minimum: 0, maximum: 1_000_000 }), includeImages: input.includeImages };
}
function search(body: JsonValue): TranscriptSearchRead | PathSuggestionsRead {
  const input = record(body);
  if (input.read === 'transcript_search') {
    exact(input, ['read', 'deadlineAtMs', 'query', 'limit']);
    return { read: input.read, deadlineAtMs: deadline(input.deadlineAtMs), query: text(input.query, 'query', { minimum: 2, maximum: 500 }), limit: integer(input.limit, 'limit', { minimum: 1, maximum: 100 }) };
  }
  if (input.read === 'path_suggestions') {
    exact(input, ['read', 'deadlineAtMs', 'prefix']);
    const prefix = text(input.prefix, 'prefix', { minimum: 0, maximum: 512 });
    if (prefix.startsWith('/') || prefix.split('/').includes('..')) return fail('prefix must be peer-home relative');
    return { read: input.read, deadlineAtMs: deadline(input.deadlineAtMs), prefix };
  }
  return fail('project read kind is invalid');
}

export function parseFleetReadRequest(request: FleetRequestEnvelope): FleetReadRequest {
  switch (request.operation) {
    case 'session.read': return { ...request, operation: request.operation, target: request.target, body: sessionRead(request.body) };
    case 'session.history': return { ...request, operation: request.operation, target: request.target, body: history(request.body) };
    case 'session.search': return { ...request, operation: request.operation, target: request.target, body: search(request.body) };
    case 'prompt.read': case 'approval.read': return { ...request, operation: request.operation, target: request.target, body: simple(request.body) };
    case 'pane.capture': return { ...request, operation: request.operation, target: request.target, body: simple(request.body) };
    default: return fail('operation is not a read');
  }
}
