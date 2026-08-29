import { FleetProtocolError } from './errors.js';
import { parseFleetProtocolFrame } from './schema.js';
import type { FleetProtocolFrame } from './types.js';

export const FLEET_MAX_FRAME_BYTES = 64 * 1024;

function canonicalValue(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new FleetProtocolError('PROTOCOL_FRAME_INVALID', 'canonical number must be finite');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(',')}]`;
  if (typeof value !== 'object') throw new FleetProtocolError('PROTOCOL_FRAME_INVALID', 'canonical value is unsupported');
  const fields = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
  return `{${fields.map(([key, item]) => `${JSON.stringify(key)}:${canonicalValue(item)}`).join(',')}}`;
}

export function canonicalFleetJson(value: unknown): string {
  return canonicalValue(value);
}

export function encodeFleetFrame(frame: FleetProtocolFrame): string {
  const encoded = canonicalFleetJson(frame);
  if (Buffer.byteLength(encoded) > FLEET_MAX_FRAME_BYTES) {
    throw new FleetProtocolError('PROTOCOL_FRAME_TOO_LARGE', 'frame exceeds size limit');
  }
  return encoded;
}

export function decodeFleetFrame(raw: Buffer | ArrayBuffer | Buffer[]): FleetProtocolFrame {
  const bytes = raw instanceof ArrayBuffer
    ? Buffer.from(raw)
    : Array.isArray(raw)
      ? Buffer.concat(raw)
      : raw;
  if (bytes.byteLength > FLEET_MAX_FRAME_BYTES) {
    throw new FleetProtocolError('PROTOCOL_FRAME_TOO_LARGE', 'frame exceeds size limit');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new FleetProtocolError('PROTOCOL_FRAME_INVALID', 'frame is not valid JSON');
    }
    throw error;
  }
  return parseFleetProtocolFrame(parsed);
}
