import type { FleetPaneReference, JsonValue } from '../../../../shared/fleet.js';
import { paneSubscriptionKey } from '../../../../shared/tmux.js';

export const REMOTE_TERMINAL_INPUT_LIMIT = 64 * 1024;
export const REMOTE_TERMINAL_DIMENSION_LIMIT = 1_000;

export type RemoteTerminalOperation = 'attach' | 'input' | 'resize' | 'close';
export type RemoteTerminalLease = Readonly<{
  readonly token: string;
  readonly ownerPrincipal: string;
  readonly peerId: string;
  readonly paneKey: string;
  readonly operations: readonly RemoteTerminalOperation[];
  readonly expiresAtMs: number;
  readonly connectionGeneration: number;
}>;
export type RemoteTerminalResume = Readonly<{
  readonly peerProcessEpoch: string;
  readonly terminalSessionId: string;
  readonly streamEpoch: string;
  readonly lastSeq: number;
}>;
export type RemoteTerminalAttach = Readonly<{
  readonly deadlineAtMs: number;
  readonly lease: RemoteTerminalLease;
  readonly cols: number;
  readonly rows: number;
  readonly resume: RemoteTerminalResume | null;
}>;
export type RemoteTerminalControl = Readonly<{
  readonly deadlineAtMs: number;
  readonly lease: RemoteTerminalLease;
  readonly streamEpoch: string;
}>;

export class RemoteTerminalContractError extends Error {
  readonly name = 'RemoteTerminalContractError';
}
function fail(message: string): never { throw new RemoteTerminalContractError(message); }
function isJsonRecord(value: JsonValue): value is Readonly<Record<string, JsonValue>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function record(value: JsonValue): Readonly<Record<string, JsonValue>> {
  return isJsonRecord(value) ? value : fail('terminal body must be an object');
}
function text(value: JsonValue | undefined, name: string): string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 && !value.includes('\0') ? value : fail(`${name} is invalid`);
}
function integer(value: JsonValue | undefined, name: string, maximum = Number.MAX_SAFE_INTEGER): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= maximum ? value : fail(`${name} is invalid`);
}
function nonnegativeInteger(value: JsonValue | undefined, name: string): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : fail(`${name} is invalid`);
}
function operation(value: JsonValue): RemoteTerminalOperation {
  if (value === 'attach' || value === 'input' || value === 'resize' || value === 'close') return value;
  return fail('terminal lease operation is invalid');
}
function lease(value: JsonValue | undefined): RemoteTerminalLease {
  const input = record(value ?? null);
  if (!Array.isArray(input.operations) || input.operations.length !== 4) fail('terminal lease operations are invalid');
  const operations = input.operations.map(operation);
  if (new Set(operations).size !== operations.length) fail('terminal lease operations are invalid');
  return {
    token: text(input.token, 'lease token'), ownerPrincipal: text(input.ownerPrincipal, 'owner principal'),
    peerId: text(input.peerId, 'peer id'), paneKey: typeof input.paneKey === 'string' && input.paneKey.length <= 5_000 ? input.paneKey : fail('pane key is invalid'), operations,
    expiresAtMs: integer(input.expiresAtMs, 'lease expiry'),
    connectionGeneration: integer(input.connectionGeneration, 'connection generation'),
  };
}
function resume(value: JsonValue | undefined): RemoteTerminalResume | null {
  if (value === null) return null;
  const input = record(value ?? null);
  return {
    peerProcessEpoch: text(input.peerProcessEpoch, 'peer process epoch'),
    terminalSessionId: text(input.terminalSessionId, 'terminal session id'),
    streamEpoch: text(input.streamEpoch, 'stream epoch'), lastSeq: nonnegativeInteger(input.lastSeq, 'last sequence'),
  };
}
function control(value: JsonValue): RemoteTerminalControl {
  const input = record(value);
  return { deadlineAtMs: integer(input.deadlineAtMs, 'deadline'), lease: lease(input.lease), streamEpoch: text(input.streamEpoch, 'stream epoch') };
}
export function parseTerminalAttach(value: JsonValue): RemoteTerminalAttach {
  const input = record(value);
  return {
    deadlineAtMs: integer(input.deadlineAtMs, 'deadline'), lease: lease(input.lease),
    cols: integer(input.cols, 'columns', REMOTE_TERMINAL_DIMENSION_LIMIT),
    rows: integer(input.rows, 'rows', REMOTE_TERMINAL_DIMENSION_LIMIT), resume: resume(input.resume),
  };
}
export function parseTerminalInput(value: JsonValue): RemoteTerminalControl & Readonly<{ readonly data: string }> {
  const input = record(value); const data = typeof input.data === 'string' && Buffer.byteLength(input.data) <= REMOTE_TERMINAL_INPUT_LIMIT ? input.data : fail('terminal input is too large');
  return { ...control(value), data };
}
export function parseTerminalResize(value: JsonValue): RemoteTerminalControl & Readonly<{ readonly cols: number; readonly rows: number }> {
  const input = record(value);
  return { ...control(value), cols: integer(input.cols, 'columns', REMOTE_TERMINAL_DIMENSION_LIMIT), rows: integer(input.rows, 'rows', REMOTE_TERMINAL_DIMENSION_LIMIT) };
}
export function parseTerminalClose(value: JsonValue): RemoteTerminalControl {
  const input = record(value); if (input.action !== 'close') fail('terminal close action is invalid'); return control(value);
}
export function assertTerminalLease(admission: Readonly<{
  readonly lease: RemoteTerminalLease; readonly target: FleetPaneReference;
  readonly operation: RemoteTerminalOperation; readonly generation: number; readonly now: number;
}>): void {
  const { lease: leaseValue, target, operation: operationValue, generation, now } = admission;
  if (leaseValue.peerId !== target.hostId || leaseValue.paneKey !== paneSubscriptionKey(target.lane, target.tmux, target.process)
    || leaseValue.connectionGeneration !== generation || leaseValue.expiresAtMs <= now || !leaseValue.operations.includes(operationValue)) {
    fail('terminal lease is invalid or expired');
  }
}
