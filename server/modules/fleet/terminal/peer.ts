import { randomUUID } from 'node:crypto';

import type { FleetErrorCode, FleetEvent, FleetPaneReference, JsonValue } from '../../../../shared/fleet.js';
import type { PeerOperationHandlers } from '../peer/operation-dispatcher.js';

import {
  assertTerminalLease, parseTerminalAttach, parseTerminalClose, parseTerminalInput, parseTerminalResize,
  type RemoteTerminalLease,
} from './contracts.js';

const OUTPUT_ENTRY_LIMIT = 512;
const OUTPUT_BYTE_LIMIT = 1024 * 1024;
type Output = Readonly<{ readonly seq: number; readonly data: string; readonly bytes: number }>;
export interface RemoteTerminalProcess {
  onData(listener: (data: string) => void): void;
  onExit(listener: () => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  close(): void;
}
export type RemoteTerminalHandlers = Readonly<{
  readonly 'pane.attach': NonNullable<PeerOperationHandlers['pane.attach']>;
  readonly 'pane.input': NonNullable<PeerOperationHandlers['pane.input']>;
  readonly 'pane.resize': NonNullable<PeerOperationHandlers['pane.resize']>;
  readonly 'pane.escape': NonNullable<PeerOperationHandlers['pane.escape']>;
}>;
type Session = {
  readonly id: string; readonly streamEpoch: string; readonly target: FleetPaneReference;
  readonly lease: RemoteTerminalLease; readonly process: RemoteTerminalProcess; readonly output: Output[];
  lastSeq: number; outputBytes: number; open: boolean;
};
export type RemoteTerminalPeerOptions = Readonly<{
  readonly hostId: string;
  readonly processEpoch: string;
  readonly now: () => number;
  readonly isConnectionCurrent: (generation: number) => boolean;
  readonly verifyTarget: (target: FleetPaneReference) => Promise<FleetPaneReference>;
  readonly spawn: (target: FleetPaneReference, cols: number, rows: number) => Promise<RemoteTerminalProcess>;
  readonly publish: (event: FleetEvent, body: JsonValue) => void;
}>;

export class RemoteTerminalPeerError extends Error {
  readonly name = 'RemoteTerminalPeerError';
  constructor(readonly code: FleetErrorCode, message: string) { super(message); }
}
function fail(message: string, code: FleetErrorCode = 'FLEET_UNAUTHORIZED'): never { throw new RemoteTerminalPeerError(code, message); }
function sameLease(left: RemoteTerminalLease, right: RemoteTerminalLease): boolean {
  return left.token === right.token && left.ownerPrincipal === right.ownerPrincipal
    && left.peerId === right.peerId && left.paneKey === right.paneKey
    && left.connectionGeneration === right.connectionGeneration && left.expiresAtMs === right.expiresAtMs;
}

export function createRemoteTerminalPeer(options: RemoteTerminalPeerOptions): Readonly<{
  readonly handlers: RemoteTerminalHandlers;
  readonly closeGeneration: (generation: number) => void;
  readonly dispose: () => void;
}> {
  const sessions = new Map<string, Session>();
  const closedGenerations = new Set<number>();
  function generationCurrent(generation: number): boolean {
    return !closedGenerations.has(generation) && options.isConnectionCurrent(generation);
  }
  function publish(session: Session, output: Output, replay = false): void {
    options.publish('pane.output', {
      terminalSessionId: session.id, streamEpoch: session.streamEpoch, peerProcessEpoch: options.processEpoch,
      seq: output.seq, data: output.data, replay, leaseToken: session.lease.token,
    });
  }
  function close(session: Session): void {
    if (!session.open) return;
    session.open = false; session.process.close(); sessions.delete(session.id);
  }
  function requireSession(target: FleetPaneReference, lease: RemoteTerminalLease, streamEpoch: string): Session {
    const session = [...sessions.values()].find((item) => item.streamEpoch === streamEpoch);
    if (session === undefined || !session.open || !sameLease(session.lease, lease) || session.target.hostId !== target.hostId || session.target.localId !== target.localId) return fail('terminal stream is unavailable');
    return session;
  }
  const attach: NonNullable<PeerOperationHandlers['pane.attach']> = async (request) => {
    if (request.operation !== 'pane.attach') return fail('terminal attach operation is invalid');
    const input = parseTerminalAttach(request.body);
    if (request.target.hostId !== options.hostId || !input.lease.ownerPrincipal) return fail('terminal owner is unauthorized');
    assertTerminalLease({ lease: input.lease, target: request.target, operation: 'attach', generation: request.connectionGeneration, now: options.now() });
    if (input.deadlineAtMs <= options.now() || !generationCurrent(request.connectionGeneration)) return fail('terminal attach admission expired');
    const prior = input.resume === null ? undefined : sessions.get(input.resume.terminalSessionId);
    if (prior !== undefined && prior.open && input.resume?.peerProcessEpoch === options.processEpoch
      && input.resume.streamEpoch === prior.streamEpoch && sameLease(prior.lease, input.lease)) {
      const oldest = prior.output[0]?.seq ?? prior.lastSeq + 1;
      const resumable = input.resume.lastSeq <= prior.lastSeq && input.resume.lastSeq >= oldest - 1;
      for (const output of prior.output) if (!resumable || output.seq > input.resume.lastSeq) publish(prior, output, true);
      return { terminalSessionId: prior.id, streamEpoch: prior.streamEpoch, peerProcessEpoch: options.processEpoch, replay: resumable ? 'resume' : 'redraw', lastSeq: prior.lastSeq };
    }
    const verified = await options.verifyTarget(request.target);
    if (input.deadlineAtMs <= options.now() || !generationCurrent(request.connectionGeneration)) return fail('terminal connection was superseded before spawn');
    const process = await options.spawn(verified, input.cols, input.rows);
    try {
      assertTerminalLease({ lease: input.lease, target: request.target, operation: 'attach', generation: request.connectionGeneration, now: options.now() });
      if (input.deadlineAtMs <= options.now() || !generationCurrent(request.connectionGeneration)) return fail('terminal connection closed during spawn', 'FLEET_STALE_GENERATION');
      await options.verifyTarget(request.target);
      assertTerminalLease({ lease: input.lease, target: request.target, operation: 'attach', generation: request.connectionGeneration, now: options.now() });
      if (input.deadlineAtMs <= options.now() || !generationCurrent(request.connectionGeneration)) return fail('terminal target became stale during spawn', 'FLEET_STALE_GENERATION');
    } catch (error) {
      process.close();
      if (error instanceof RemoteTerminalPeerError) throw error;
      if (error instanceof Error) return fail('terminal authority became stale during spawn', 'FLEET_STALE_GENERATION');
      throw error;
    }
    const session: Session = { id: randomUUID(), streamEpoch: randomUUID(), target: request.target, lease: input.lease, process, output: [], lastSeq: 0, outputBytes: 0, open: true };
    sessions.set(session.id, session);
    process.onData((data) => {
      if (!session.open) return;
      const output = { seq: ++session.lastSeq, data, bytes: Buffer.byteLength(data) };
      session.output.push(output); session.outputBytes += output.bytes;
      while (session.output.length > OUTPUT_ENTRY_LIMIT || session.outputBytes > OUTPUT_BYTE_LIMIT) {
        const removed = session.output.shift(); if (removed !== undefined) session.outputBytes -= removed.bytes;
      }
      publish(session, output);
    });
    process.onExit(() => { session.open = false; sessions.delete(session.id); });
    return { terminalSessionId: session.id, streamEpoch: session.streamEpoch, peerProcessEpoch: options.processEpoch, replay: 'redraw', lastSeq: 0 };
  };
  const input: NonNullable<PeerOperationHandlers['pane.input']> = async (request) => {
    if (request.operation !== 'pane.input') return fail('terminal input operation is invalid');
    const parsed = parseTerminalInput(request.body); assertTerminalLease({ lease: parsed.lease, target: request.target, operation: 'input', generation: request.connectionGeneration, now: options.now() });
    if (!generationCurrent(request.connectionGeneration) || parsed.deadlineAtMs <= options.now()) return fail('terminal input is suspended');
    requireSession(request.target, parsed.lease, parsed.streamEpoch).process.write(parsed.data); return { ok: true };
  };
  const resize: NonNullable<PeerOperationHandlers['pane.resize']> = async (request) => {
    if (request.operation !== 'pane.resize') return fail('terminal resize operation is invalid');
    const parsed = parseTerminalResize(request.body); assertTerminalLease({ lease: parsed.lease, target: request.target, operation: 'resize', generation: request.connectionGeneration, now: options.now() });
    if (!generationCurrent(request.connectionGeneration) || parsed.deadlineAtMs <= options.now()) return fail('terminal resize is suspended');
    requireSession(request.target, parsed.lease, parsed.streamEpoch).process.resize(parsed.cols, parsed.rows); return { ok: true };
  };
  const closeHandler: NonNullable<PeerOperationHandlers['pane.escape']> = async (request) => {
    if (request.operation !== 'pane.escape') return fail('terminal close operation is invalid');
    const parsed = parseTerminalClose(request.body); assertTerminalLease({ lease: parsed.lease, target: request.target, operation: 'close', generation: request.connectionGeneration, now: options.now() });
    close(requireSession(request.target, parsed.lease, parsed.streamEpoch)); return { ok: true };
  };
  return {
    handlers: { 'pane.attach': attach, 'pane.input': input, 'pane.resize': resize, 'pane.escape': closeHandler },
    closeGeneration: (generation) => {
      closedGenerations.add(generation);
      for (const session of [...sessions.values()]) if (session.lease.connectionGeneration === generation) close(session);
    },
    dispose: () => { for (const session of [...sessions.values()]) close(session); },
  };
}
