import {
  FLEET_CAPABILITIES,
  FLEET_PROTOCOL_VERSIONS,
  parseFleetEventEnvelope,
  parseFleetRequestEnvelope,
  parseFleetResponseEnvelope,
  type FleetCapability,
  type FleetProtocolVersion,
} from '../../../../shared/fleet.js';

import { FleetProtocolError } from './errors.js';
import {
  FLEET_AUTH_ROLES,
  FLEET_TRANSPORT_MODES,
  type FleetAuthRole,
  type FleetHelloFrame,
  type FleetHeartbeatFrame,
  type FleetProofFrame,
  type FleetProtocolFrame,
  type FleetTransportMode,
} from './types.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const NONCE = /^[A-Za-z0-9_-]{43}$/;
const SIGNATURE = /^[A-Za-z0-9_-]{86}$/;
const MAX_EPOCH_LENGTH = 128;

type RecordValue = Readonly<Record<string, unknown>>;

function invalid(message: string): never {
  throw new FleetProtocolError('PROTOCOL_FRAME_INVALID', message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function record(value: unknown): RecordValue {
  if (!isRecord(value)) invalid('frame must be an object');
  return value;
}

function exact(value: RecordValue, keys: readonly string[]): void {
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) {
    invalid('frame has unexpected fields');
  }
}

function oneOf<T extends readonly string[]>(value: unknown, choices: T, name: string): T[number] {
  if (typeof value !== 'string') invalid(`${name} must be a string`);
  const result = choices.find((choice) => choice === value);
  if (result === undefined) invalid(`${name} is unsupported`);
  return result;
}

function uuid(value: unknown, name: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) invalid(`${name} must be a UUID-v4`);
  return value;
}

function epoch(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_EPOCH_LENGTH) {
    invalid('processEpoch is invalid');
  }
  return value;
}

function positiveInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    invalid(`${name} must be a positive integer`);
  }
  return value;
}

function uniqueList<T extends string>(value: unknown, choices: readonly T[], name: string): readonly T[] {
  if (!Array.isArray(value)) invalid(`${name} must be an array`);
  const result = value.map((item) => oneOf(item, choices, name));
  if (result.length === 0 || new Set(result).size !== result.length) invalid(`${name} must be non-empty and unique`);
  return result;
}

export function parseFleetHello(value: unknown): FleetHelloFrame {
  const input = record(value);
  exact(input, ['kind', 'role', 'installationId', 'processEpoch', 'connectionId', 'nonce', 'protocolVersions', 'capabilities', 'transportMode']);
  if (input.kind !== 'auth.hello') invalid('frame kind must be auth.hello');
  if (typeof input.nonce !== 'string' || !NONCE.test(input.nonce)) invalid('nonce must encode 32 bytes');
  return {
    kind: 'auth.hello',
    role: oneOf(input.role, FLEET_AUTH_ROLES, 'role') satisfies FleetAuthRole,
    installationId: uuid(input.installationId, 'installationId'),
    processEpoch: epoch(input.processEpoch),
    connectionId: uuid(input.connectionId, 'connectionId'),
    nonce: input.nonce,
    protocolVersions: uniqueList(input.protocolVersions, FLEET_PROTOCOL_VERSIONS, 'protocolVersions') satisfies readonly FleetProtocolVersion[],
    capabilities: uniqueList(input.capabilities, FLEET_CAPABILITIES, 'capabilities') satisfies readonly FleetCapability[],
    transportMode: oneOf(input.transportMode, FLEET_TRANSPORT_MODES, 'transportMode') satisfies FleetTransportMode,
  };
}

export function parseFleetProof(value: unknown): FleetProofFrame {
  const input = record(value);
  exact(input, ['kind', 'role', 'installationId', 'connectionId', 'signature']);
  if (input.kind !== 'auth.proof') invalid('frame kind must be auth.proof');
  if (typeof input.signature !== 'string' || !SIGNATURE.test(input.signature)) invalid('signature must encode Ed25519 bytes');
  return {
    kind: 'auth.proof',
    role: oneOf(input.role, FLEET_AUTH_ROLES, 'role'),
    installationId: uuid(input.installationId, 'installationId'),
    connectionId: uuid(input.connectionId, 'connectionId'),
    signature: input.signature,
  };
}

export function parseFleetHeartbeat(value: unknown): FleetHeartbeatFrame {
  const input = record(value);
  exact(input, ['kind', 'connectionGeneration', 'sentAtMs']);
  if (input.kind !== 'heartbeat') invalid('frame kind must be heartbeat');
  return { kind: 'heartbeat', connectionGeneration: positiveInteger(input.connectionGeneration, 'connectionGeneration'), sentAtMs: positiveInteger(input.sentAtMs, 'sentAtMs') };
}

export function parseFleetProtocolFrame(value: unknown): FleetProtocolFrame {
  const input = record(value);
  switch (input.kind) {
    case 'auth.hello': return parseFleetHello(input);
    case 'auth.proof': return parseFleetProof(input);
    case 'heartbeat': return parseFleetHeartbeat(input);
    case 'request': return parseFleetRequestEnvelope(input);
    case 'response': return parseFleetResponseEnvelope(input);
    case 'event': return parseFleetEventEnvelope(input);
    default: return invalid('frame kind is unsupported');
  }
}
