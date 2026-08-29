import type { HostTmuxPaneTarget } from './tmux.js';

export const FLEET_PROTOCOL_VERSION = 'fleet/1' as const;
export const FLEET_MAX_HOSTS = 10 as const;
export const FLEET_MAX_REMOTE_PEERS = FLEET_MAX_HOSTS - 1;
export const FLEET_PROTOCOL_VERSIONS = [FLEET_PROTOCOL_VERSION] as const;
export const FLEET_CAPABILITIES = ['catalog.read', 'session.read', 'chat.control', 'prompt.respond', 'pane.read', 'terminal.attach', 'terminal.input', 'session.spawn', 'session.terminate', 'completion.event'] as const;
export const FLEET_PEER_STATES = ['connecting', 'syncing', 'online', 'degraded', 'offline', 'revoked', 'incompatible'] as const;
export const FLEET_ERROR_CODES = ['FLEET_MALFORMED_FRAME', 'FLEET_UNSUPPORTED_PROTOCOL', 'FLEET_DUPLICATE_CAPABILITY', 'FLEET_IDENTIFIER_INVALID', 'FLEET_IDENTIFIER_TOO_LONG', 'FLEET_UNKNOWN_OPERATION', 'FLEET_UNKNOWN_EVENT', 'FLEET_UNKNOWN_ERROR', 'FLEET_CAPABILITY_UNAVAILABLE', 'HOST_NOT_FOUND', 'HOST_OFFLINE', 'HOST_SYNCING', 'HOST_REVOKED', 'HOST_INCOMPATIBLE', 'HOST_COMMAND_OUTCOME_UNKNOWN', 'FLEET_STALE_GENERATION', 'FLEET_DUPLICATE_REQUEST_CONFLICT', 'FLEET_REQUEST_CACHE_FULL', 'FLEET_DEADLINE_EXCEEDED', 'FLEET_FRAME_TOO_LARGE', 'FLEET_UNAUTHORIZED'] as const;
export const FLEET_OPERATIONS = ['catalog.snapshot', 'session.read', 'session.history', 'session.search', 'chat.send', 'chat.abort', 'prompt.read', 'prompt.respond', 'approval.read', 'approval.respond', 'pane.capture', 'pane.attach', 'pane.input', 'pane.resize', 'pane.interrupt', 'pane.escape', 'pane.terminate', 'process.terminate', 'session.spawn', 'session.terminate'] as const;
export const FLEET_EVENTS = ['catalog.snapshot', 'catalog.delta', 'host.state', 'chat.delta', 'prompt.changed', 'approval.changed', 'pane.output', 'completion.ready'] as const;

export type FleetProtocolVersion = typeof FLEET_PROTOCOL_VERSIONS[number];
export type FleetCapability = typeof FLEET_CAPABILITIES[number];
export type FleetPeerState = typeof FLEET_PEER_STATES[number];
export type FleetErrorCode = typeof FLEET_ERROR_CODES[number];
export type FleetOperation = typeof FLEET_OPERATIONS[number];
export type FleetEvent = typeof FLEET_EVENTS[number];
export type FleetLane = 'external' | 'live';
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | Readonly<{ readonly [key: string]: JsonValue }>;
export type FleetHostReference = Readonly<{ readonly kind: 'host'; readonly hostId: string }>;
export type FleetSessionReference = Readonly<{ readonly kind: 'session'; readonly hostId: string; readonly localId: string }>;
export type FleetProjectReference = Readonly<{ readonly kind: 'project'; readonly hostId: string; readonly localId: string }>;
export type FleetPaneReference = Readonly<{ readonly kind: 'pane'; readonly localId: string } & HostTmuxPaneTarget>;
export type FleetReference = FleetHostReference | FleetSessionReference | FleetProjectReference | FleetPaneReference;
export type FleetInstallationDescriptor = Readonly<{ readonly installationId: string; readonly publicKeyFingerprint: string; readonly protocolVersions: readonly FleetProtocolVersion[]; readonly capabilities: readonly FleetCapability[] }>;
export type FleetPeerDescriptor = Readonly<{ readonly hostId: string; readonly displayLabel: string; readonly state: FleetPeerState; readonly protocolVersion: FleetProtocolVersion | null; readonly capabilities: readonly FleetCapability[] }>;
type FleetEnvelopeBase = Readonly<{ readonly protocolVersion: FleetProtocolVersion; readonly connectionGeneration: number }>;
type FleetRequestBase = FleetEnvelopeBase & Readonly<{ readonly kind: 'request'; readonly requestId: string; readonly body: JsonValue }>;
type FleetSessionOperation = 'session.read' | 'session.history' | 'chat.send' | 'chat.abort' | 'prompt.read' | 'prompt.respond' | 'approval.read' | 'approval.respond';
type FleetProjectOperation = 'session.search' | 'session.spawn';
type FleetPaneOperation = 'pane.capture' | 'pane.attach' | 'pane.input' | 'pane.resize' | 'pane.interrupt' | 'pane.escape' | 'pane.terminate' | 'process.terminate' | 'session.terminate';
export type FleetRequestEnvelope = FleetRequestBase & (
  Readonly<{ readonly operation: 'catalog.snapshot'; readonly target: FleetHostReference }> |
  Readonly<{ readonly operation: FleetSessionOperation; readonly target: FleetSessionReference }> |
  Readonly<{ readonly operation: FleetProjectOperation; readonly target: FleetProjectReference }> |
  Readonly<{ readonly operation: FleetPaneOperation; readonly target: FleetPaneReference }>
);
export type FleetResponseEnvelope = FleetEnvelopeBase & (Readonly<{ readonly kind: 'response'; readonly requestId: string; readonly target: FleetReference; readonly status: 'success'; readonly sideEffect: 'none' | 'applied'; readonly body: JsonValue }> | Readonly<{ readonly kind: 'response'; readonly requestId: string; readonly target: FleetReference; readonly status: 'failure'; readonly sideEffect: 'none' | 'possible'; readonly error: FleetErrorCode; readonly body: JsonValue }>);
export type FleetEventEnvelope = FleetEnvelopeBase & Readonly<{ readonly kind: 'event'; readonly eventId: string; readonly event: FleetEvent; readonly hostId: string; readonly body: JsonValue }>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_IDENTIFIER_LENGTH = 256;

export class FleetContractError extends Error {
  readonly code: FleetErrorCode;
  constructor(code: FleetErrorCode, message: string) { super(message); this.code = code; this.name = 'FleetContractError'; }
}

function fail(code: FleetErrorCode, message: string): never { throw new FleetContractError(code, message); }
function assertNever(value: never): never { return fail('FLEET_MALFORMED_FRAME', `unexpected value: ${String(value)}`); }
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function record(value: unknown, name: string): Readonly<Record<string, unknown>> {
  if (!isPlainRecord(value)) fail('FLEET_MALFORMED_FRAME', `${name} must be an object`);
  return value;
}
function exact(value: Readonly<Record<string, unknown>>, keys: readonly string[], name: string): void {
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) fail('FLEET_MALFORMED_FRAME', `${name} has unexpected fields`);
}
function literal<T extends readonly string[]>(value: unknown, values: T, code: FleetErrorCode, name: string): T[number] {
  if (typeof value !== 'string') fail(code, `${name} must be a string`);
  const found = values.find((candidate) => candidate === value);
  if (found === undefined) fail(code, `${name} is unsupported`);
  return found;
}
function identifier(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.length || value.length > MAX_IDENTIFIER_LENGTH || value.includes('\0') || /[\uD800-\uDFFF]/.test(value)) fail(value !== null && typeof value === 'string' && value.length > MAX_IDENTIFIER_LENGTH ? 'FLEET_IDENTIFIER_TOO_LONG' : 'FLEET_IDENTIFIER_INVALID', `${name} is invalid`);
  return value;
}
function hostId(value: unknown): string { const result = identifier(value, 'hostId'); if (!UUID.test(result)) fail('FLEET_IDENTIFIER_INVALID', 'hostId must be a UUID'); return result; }
function positiveInteger(value: unknown, name: string): number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) fail('FLEET_MALFORMED_FRAME', `${name} must be a positive integer`); return value; }
function scalarString(value: unknown, name: string): string { return identifier(value, name); }
function capabilities(value: unknown): readonly FleetCapability[] {
  if (!Array.isArray(value)) fail('FLEET_MALFORMED_FRAME', 'capabilities must be an array');
  const result = value.map((item) => literal(item, FLEET_CAPABILITIES, 'FLEET_CAPABILITY_UNAVAILABLE', 'capability'));
  if (new Set(result).size !== result.length) fail('FLEET_DUPLICATE_CAPABILITY', 'capabilities must be unique');
  return result;
}
function json(value: unknown): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') { if (!Number.isFinite(value)) fail('FLEET_MALFORMED_FRAME', 'body number must be finite'); return value; }
  if (Array.isArray(value)) return value.map(json);
  const object = record(value, 'body');
  const result: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(object)) result[key] = key === 'capabilities' ? capabilities(item) : json(item);
  return result;
}
function hostTarget(value: unknown): FleetHostReference {
  const input = record(value, 'host target'); exact(input, ['kind', 'hostId'], 'host target');
  return { kind: literal(input.kind, ['host'] as const, 'FLEET_MALFORMED_FRAME', 'target kind'), hostId: hostId(input.hostId) };
}
function sessionTarget(value: unknown): FleetSessionReference {
  const input = record(value, 'session target'); exact(input, ['kind', 'hostId', 'localId'], 'session target');
  return { kind: literal(input.kind, ['session'] as const, 'FLEET_MALFORMED_FRAME', 'target kind'), hostId: hostId(input.hostId), localId: identifier(input.localId, 'localId') };
}
function projectTarget(value: unknown): FleetProjectReference {
  const input = record(value, 'project target'); exact(input, ['kind', 'hostId', 'localId'], 'project target');
  return { kind: literal(input.kind, ['project'] as const, 'FLEET_MALFORMED_FRAME', 'target kind'), hostId: hostId(input.hostId), localId: identifier(input.localId, 'localId') };
}
function paneTarget(value: unknown): FleetPaneReference {
  const input = record(value, 'pane target'); exact(input, ['kind', 'hostId', 'localId', 'lane', 'tmux', 'process'], 'pane target');
  const tmux = record(input.tmux, 'tmux'); exact(tmux, ['socketPath', 'sessionId', 'windowId', 'paneId'], 'tmux');
  const process = record(input.process, 'process'); exact(process, ['pid', 'startedAtMs'], 'process');
  return { kind: literal(input.kind, ['pane'] as const, 'FLEET_MALFORMED_FRAME', 'target kind'), hostId: hostId(input.hostId), localId: identifier(input.localId, 'localId'), lane: literal(input.lane, ['external', 'live'] as const, 'FLEET_MALFORMED_FRAME', 'lane'), tmux: { socketPath: scalarString(tmux.socketPath, 'socketPath'), sessionId: scalarString(tmux.sessionId, 'sessionId'), windowId: scalarString(tmux.windowId, 'windowId'), paneId: scalarString(tmux.paneId, 'paneId') }, process: { pid: positiveInteger(process.pid, 'pid'), startedAtMs: positiveInteger(process.startedAtMs, 'startedAtMs') } };
}
export function parseFleetReference(value: unknown): FleetReference {
  const input = record(value, 'target');
  const kind = literal(input.kind, ['host', 'session', 'project', 'pane'] as const, 'FLEET_MALFORMED_FRAME', 'target kind');
  switch (kind) {
    case 'host': return hostTarget(input);
    case 'session': return sessionTarget(input);
    case 'project': return projectTarget(input);
    case 'pane': return paneTarget(input);
    default: return assertNever(kind);
  }
}
function base(value: unknown, kind: 'request' | 'response' | 'event'): FleetEnvelopeBase & Readonly<Record<string, unknown>> {
  const input = record(value, 'frame');
  if (input.kind !== kind) fail('FLEET_MALFORMED_FRAME', `frame kind must be ${kind}`);
  const protocolVersion = literal(input.protocolVersion, FLEET_PROTOCOL_VERSIONS, 'FLEET_UNSUPPORTED_PROTOCOL', 'protocolVersion');
  return { ...input, protocolVersion, connectionGeneration: positiveInteger(input.connectionGeneration, 'connectionGeneration') };
}
export function parseFleetRequestEnvelope(value: unknown): FleetRequestEnvelope {
  const input = base(value, 'request'); exact(input, ['kind', 'protocolVersion', 'connectionGeneration', 'requestId', 'operation', 'target', 'body'], 'request');
  const request = { kind: 'request' as const, protocolVersion: input.protocolVersion, connectionGeneration: input.connectionGeneration, requestId: identifier(input.requestId, 'requestId'), body: json(input.body) };
  const operation = literal(input.operation, FLEET_OPERATIONS, 'FLEET_UNKNOWN_OPERATION', 'operation');
  switch (operation) {
    case 'catalog.snapshot': return { ...request, operation, target: hostTarget(input.target) };
    case 'session.read': case 'session.history': case 'chat.send': case 'chat.abort': case 'prompt.read': case 'prompt.respond': case 'approval.read': case 'approval.respond': return { ...request, operation, target: sessionTarget(input.target) };
    case 'session.search': case 'session.spawn': return { ...request, operation, target: projectTarget(input.target) };
    case 'pane.capture': case 'pane.attach': case 'pane.input': case 'pane.resize': case 'pane.interrupt': case 'pane.escape': case 'pane.terminate': case 'process.terminate': case 'session.terminate': return { ...request, operation, target: paneTarget(input.target) };
    default: return assertNever(operation);
  }
}
export function parseFleetResponseEnvelope(value: unknown): FleetResponseEnvelope {
  const input = base(value, 'response');
  const status = literal(input.status, ['success', 'failure'] as const, 'FLEET_MALFORMED_FRAME', 'response status');
  const shared = { kind: 'response' as const, protocolVersion: input.protocolVersion, connectionGeneration: input.connectionGeneration, requestId: identifier(input.requestId, 'requestId'), target: parseFleetReference(input.target), body: json(input.body) };
  if (status === 'success') {
    exact(input, ['kind', 'protocolVersion', 'connectionGeneration', 'requestId', 'target', 'status', 'sideEffect', 'body'], 'success response');
    return { ...shared, status, sideEffect: literal(input.sideEffect, ['none', 'applied'] as const, 'FLEET_MALFORMED_FRAME', 'sideEffect') };
  }
  exact(input, ['kind', 'protocolVersion', 'connectionGeneration', 'requestId', 'target', 'status', 'sideEffect', 'error', 'body'], 'failure response');
  return { ...shared, status, sideEffect: literal(input.sideEffect, ['none', 'possible'] as const, 'FLEET_MALFORMED_FRAME', 'sideEffect'), error: literal(input.error, FLEET_ERROR_CODES, 'FLEET_UNKNOWN_ERROR', 'error') };
}
export function parseFleetEventEnvelope(value: unknown): FleetEventEnvelope {
  const input = base(value, 'event'); exact(input, ['kind', 'protocolVersion', 'connectionGeneration', 'eventId', 'event', 'hostId', 'body'], 'event');
  return { kind: 'event', protocolVersion: input.protocolVersion, connectionGeneration: input.connectionGeneration, eventId: identifier(input.eventId, 'eventId'), event: literal(input.event, FLEET_EVENTS, 'FLEET_UNKNOWN_EVENT', 'event'), hostId: hostId(input.hostId), body: json(input.body) };
}
export function parseFleetInstallationDescriptor(value: unknown): FleetInstallationDescriptor {
  const input = record(value, 'installation descriptor'); exact(input, ['installationId', 'publicKeyFingerprint', 'protocolVersions', 'capabilities'], 'installation descriptor');
  if (!Array.isArray(input.protocolVersions)) fail('FLEET_MALFORMED_FRAME', 'protocolVersions must be an array');
  const protocolVersions = input.protocolVersions.map((version) => literal(version, FLEET_PROTOCOL_VERSIONS, 'FLEET_UNSUPPORTED_PROTOCOL', 'protocolVersion'));
  if (new Set(protocolVersions).size !== protocolVersions.length) fail('FLEET_MALFORMED_FRAME', 'protocolVersions must be unique');
  return { installationId: hostId(input.installationId), publicKeyFingerprint: identifier(input.publicKeyFingerprint, 'publicKeyFingerprint'), protocolVersions, capabilities: capabilities(input.capabilities) };
}
export function parseFleetPeerDescriptor(value: unknown): FleetPeerDescriptor {
  const input = record(value, 'peer descriptor'); exact(input, ['hostId', 'displayLabel', 'state', 'protocolVersion', 'capabilities'], 'peer descriptor');
  const protocolVersion = input.protocolVersion === null ? null : literal(input.protocolVersion, FLEET_PROTOCOL_VERSIONS, 'FLEET_UNSUPPORTED_PROTOCOL', 'protocolVersion');
  return { hostId: hostId(input.hostId), displayLabel: identifier(input.displayLabel, 'displayLabel'), state: literal(input.state, FLEET_PEER_STATES, 'FLEET_MALFORMED_FRAME', 'peer state'), protocolVersion, capabilities: capabilities(input.capabilities) };
}
export function lengthPrefixedFields(fields: readonly string[]): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder(); const chunks = fields.map((field) => { const value = identifier(field, 'digest field'); const bytes = encoder.encode(value); const chunk = new Uint8Array(4 + bytes.length); new DataView(chunk.buffer).setUint32(0, bytes.length); chunk.set(bytes, 4); return chunk; });
  const result = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0)); let offset = 0; for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; } return result;
}
export async function fleetDigest(domain: string, fields: readonly string[]): Promise<string> {
  const bytes = lengthPrefixedFields([FLEET_PROTOCOL_VERSION, identifier(domain, 'digest domain'), ...fields]);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)); return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
export function fleetReferenceDigest(reference: FleetReference): Promise<string> {
  switch (reference.kind) {
    case 'host': return fleetDigest('host', [reference.hostId]);
    case 'session': return fleetDigest('session', [reference.hostId, reference.localId]);
    case 'project': return fleetDigest('project', [reference.hostId, reference.localId]);
    case 'pane': return fleetDigest('pane', [reference.hostId, reference.localId, reference.lane, reference.tmux.socketPath, reference.tmux.sessionId, reference.tmux.windowId, reference.tmux.paneId, String(reference.process.pid), String(reference.process.startedAtMs)]);
    default: return assertNever(reference);
  }
}
export function fleetCapabilityLabel(capability: FleetCapability): string {
  switch (capability) { case 'catalog.read': return 'catalog'; case 'session.read': return 'session'; case 'chat.control': return 'chat'; case 'prompt.respond': return 'prompt'; case 'pane.read': return 'pane'; case 'terminal.attach': return 'terminal attach'; case 'terminal.input': return 'terminal input'; case 'session.spawn': return 'session spawn'; case 'session.terminate': return 'session terminate'; case 'completion.event': return 'completion'; default: return assertNever(capability); }
}
export function fleetErrorStatus(code: FleetErrorCode): number {
  switch (code) { case 'FLEET_MALFORMED_FRAME': case 'FLEET_IDENTIFIER_INVALID': case 'FLEET_IDENTIFIER_TOO_LONG': case 'FLEET_DUPLICATE_CAPABILITY': return 400; case 'FLEET_UNAUTHORIZED': return 403; case 'HOST_NOT_FOUND': return 404; case 'HOST_OFFLINE': case 'HOST_SYNCING': case 'HOST_INCOMPATIBLE': return 503; case 'HOST_REVOKED': return 410; case 'HOST_COMMAND_OUTCOME_UNKNOWN': case 'FLEET_STALE_GENERATION': case 'FLEET_DUPLICATE_REQUEST_CONFLICT': return 409; case 'FLEET_REQUEST_CACHE_FULL': case 'FLEET_FRAME_TOO_LARGE': return 429; case 'FLEET_UNSUPPORTED_PROTOCOL': case 'FLEET_CAPABILITY_UNAVAILABLE': case 'FLEET_UNKNOWN_OPERATION': case 'FLEET_UNKNOWN_EVENT': case 'FLEET_UNKNOWN_ERROR': return 422; case 'FLEET_DEADLINE_EXCEEDED': return 504; default: return assertNever(code); }
}
