import { randomBytes, randomUUID } from 'node:crypto';

import { FLEET_PROTOCOL_VERSION, type FleetPaneReference, type FleetRequestEnvelope, type JsonValue } from '../../../../shared/fleet.js';
import { paneSubscriptionKey } from '../../../../shared/tmux.js';
import type { HubPeerStatus } from '../hub/connection/types.js';
import type { FleetProtocolFrame } from '../protocol/types.js';

import type { RemoteTerminalLease, RemoteTerminalResume } from './contracts.js';

export interface RemoteTerminalChannel {
  status(hostId: string): HubPeerStatus | undefined;
  send(hostId: string, frame: FleetProtocolFrame): boolean;
  subscribeFrames(listener: (hostId: string, frame: FleetProtocolFrame) => void): () => void;
  subscribeStatus(listener: (status: HubPeerStatus) => void): () => void;
}
export interface RemoteTerminalSink {
  readonly bufferedAmount: number;
  output(data: string, seq: number, replay: boolean): void;
  close(reason: 'closed' | 'disconnected' | 'revoked' | 'slow_consumer'): void;
}
export type RemoteTerminalAttachment = Readonly<{
  readonly resume: RemoteTerminalResume;
  readonly replay: 'resume' | 'redraw';
  readonly input: (data: string, deadlineAtMs: number) => Promise<void>;
  readonly resize: (cols: number, rows: number, deadlineAtMs: number) => Promise<void>;
  readonly close: (deadlineAtMs: number) => Promise<void>;
  readonly detach: () => void;
}>;
type RemoteTerminalCall = Readonly<{ readonly target: FleetPaneReference; readonly operation: 'pane.attach' | 'pane.input' | 'pane.resize' | 'pane.escape'; readonly body: JsonValue; readonly generation: number; readonly deadlineAtMs: number }>;
type Pending = Readonly<{ readonly hostId: string; readonly generation: number; readonly resolve: (body: JsonValue) => void; readonly reject: (error: Error) => void; readonly timer: NodeJS.Timeout }>;
type Active = Readonly<{ readonly target: FleetPaneReference; readonly lease: RemoteTerminalLease; readonly streamEpoch: string; readonly peerProcessEpoch: string; readonly sink: RemoteTerminalSink }>;
type ResumeLease = Readonly<{ readonly principal: string; readonly target: FleetPaneReference; readonly lease: RemoteTerminalLease; readonly identity: RemoteTerminalResume }>;
const MAX_RESUME_LEASES = 1_024;
const REMOTE_TERMINAL_OPERATIONS = ['attach', 'input', 'resize', 'close'] as const;
export type RemoteTerminalClientOptions = Readonly<{ readonly now?: () => number; readonly leaseTtlMs?: number; readonly maxBufferedBytes?: number }>;

export class RemoteTerminalClientError extends Error { readonly name = 'RemoteTerminalClientError'; }
function fail(message: string): never { throw new RemoteTerminalClientError(message); }
function isJsonRecord(value: JsonValue): value is Readonly<Record<string, JsonValue>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function record(value: JsonValue): Readonly<Record<string, JsonValue>> {
  return isJsonRecord(value) ? value : fail('terminal response is malformed');
}
function text(value: JsonValue | undefined, name: string): string { return typeof value === 'string' && value.length > 0 ? value : fail(`${name} is missing`); }
function integer(value: JsonValue | undefined, name: string): number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : fail(`${name} is invalid`); }

export class RemoteTerminalClient {
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxBufferedBytes: number;
  private readonly pending = new Map<string, Pending>();
  private readonly active = new Map<string, Active>();
  private readonly resumeLeases = new Map<string, ResumeLease>();
  private readonly releaseFrames: () => void;
  private readonly releaseStatus: () => void;

  constructor(private readonly channel: RemoteTerminalChannel, options: RemoteTerminalClientOptions = {}) {
    this.now = options.now ?? Date.now; this.ttlMs = options.leaseTtlMs ?? 60_000; this.maxBufferedBytes = options.maxBufferedBytes ?? 4 * 1024 * 1024;
    this.releaseFrames = channel.subscribeFrames((hostId, frame) => this.frame(hostId, frame));
    this.releaseStatus = channel.subscribeStatus((status) => this.status(status));
  }

  async attach(input: Readonly<{
    readonly principal: string; readonly owner: boolean; readonly target: FleetPaneReference;
    readonly cols: number; readonly rows: number; readonly deadlineAtMs: number;
    readonly resume: RemoteTerminalResume | null; readonly sink: RemoteTerminalSink;
  }>): Promise<RemoteTerminalAttachment> {
    if (!input.owner || input.principal.length === 0) return fail('fleet owner is required');
    const status = this.requireOnline(input.target.hostId, 'terminal.attach');
    const generation = status.generation;
    if (generation === null || status.peerProcessEpoch === null) return fail('terminal peer is synchronizing');
    const now = this.now();
    for (const [key, recordValue] of this.resumeLeases) if (recordValue.lease.expiresAtMs <= now) this.resumeLeases.delete(key);
    const requestedResume = input.resume?.peerProcessEpoch === status.peerProcessEpoch ? input.resume : null;
    const requestedKey = requestedResume === null ? null : this.resumeKey(input.target.hostId, requestedResume);
    const saved = requestedKey === null ? undefined : this.resumeLeases.get(requestedKey);
    const paneKey = paneSubscriptionKey(input.target.lane, input.target.tmux, input.target.process);
    const reusable = saved !== undefined && saved.principal === input.principal
      && saved.target.hostId === input.target.hostId && saved.target.localId === input.target.localId
      && saved.lease.peerId === input.target.hostId && saved.lease.paneKey === paneKey
      && saved.lease.connectionGeneration === generation && saved.lease.expiresAtMs > now
      && saved.lease.operations.length === REMOTE_TERMINAL_OPERATIONS.length
      && REMOTE_TERMINAL_OPERATIONS.every((operation) => saved.lease.operations.includes(operation));
    const lease: RemoteTerminalLease = reusable ? saved.lease : {
      token: randomBytes(32).toString('base64url'), ownerPrincipal: input.principal,
      peerId: input.target.hostId, paneKey, operations: REMOTE_TERMINAL_OPERATIONS,
      expiresAtMs: now + this.ttlMs, connectionGeneration: generation,
    };
    const resume = reusable ? requestedResume : null;
    const provisionalKey = ['lease', lease.token].join('\0');
    this.active.set(provisionalKey, { target: input.target, lease, streamEpoch: resume?.streamEpoch ?? '', peerProcessEpoch: status.peerProcessEpoch, sink: input.sink });
    let responseValue: JsonValue;
    try {
      responseValue = await this.call({ target: input.target, operation: 'pane.attach', body: { deadlineAtMs: input.deadlineAtMs, lease, cols: input.cols, rows: input.rows, resume }, generation, deadlineAtMs: input.deadlineAtMs });
    } catch (error) {
      this.active.delete(provisionalKey);
      throw error;
    }
    const response = record(responseValue);
    const terminalSessionId = text(response.terminalSessionId, 'terminal session id');
    const streamEpoch = text(response.streamEpoch, 'stream epoch');
    const peerProcessEpoch = text(response.peerProcessEpoch, 'peer process epoch');
    const replay = response.replay === 'resume' ? 'resume' : response.replay === 'redraw' ? 'redraw' : fail('terminal replay mode is invalid');
    const lastSeq = integer(response.lastSeq, 'last sequence');
    const identity = { peerProcessEpoch, terminalSessionId, streamEpoch, lastSeq };
    const key = [input.target.hostId, terminalSessionId, streamEpoch].join('\0');
    const resumeKey = this.resumeKey(input.target.hostId, identity);
    this.active.delete(provisionalKey);
    this.active.set(key, { target: input.target, lease, streamEpoch, peerProcessEpoch, sink: input.sink });
    this.resumeLeases.set(resumeKey, { principal: input.principal, target: input.target, lease, identity });
    if (this.resumeLeases.size > MAX_RESUME_LEASES) {
      const oldest = this.resumeLeases.keys().next().value;
      if (oldest !== undefined) this.resumeLeases.delete(oldest);
    }
    const control = (operation: 'pane.input' | 'pane.resize' | 'pane.escape', body: JsonValue, deadlineAtMs: number): Promise<void> => {
      const current = this.channel.status(input.target.hostId);
      if (lease.expiresAtMs <= this.now() || !this.active.has(key) || current?.generation !== generation || (current.state !== 'online' && current.state !== 'degraded')) return Promise.reject(new RemoteTerminalClientError('terminal input is suspended'));
      return this.call({ target: input.target, operation, body, generation, deadlineAtMs }).then(() => undefined);
    };
    return {
      resume: identity, replay,
      input: (data, deadlineAtMs) => control('pane.input', { deadlineAtMs, lease, streamEpoch, data }, deadlineAtMs),
      resize: (cols, rows, deadlineAtMs) => control('pane.resize', { deadlineAtMs, lease, streamEpoch, cols, rows }, deadlineAtMs),
      close: async (deadlineAtMs) => { await control('pane.escape', { deadlineAtMs, lease, streamEpoch, action: 'close' }, deadlineAtMs); this.active.delete(key); this.resumeLeases.delete(resumeKey); input.sink.close('closed'); },
      detach: () => this.active.delete(key),
    };
  }

  dispose(): void {
    this.releaseFrames(); this.releaseStatus();
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new RemoteTerminalClientError('terminal client stopped')); }
    this.pending.clear(); for (const active of this.active.values()) active.sink.close('disconnected'); this.active.clear(); this.resumeLeases.clear();
  }

  private requireOnline(hostId: string, capability: 'terminal.attach'): HubPeerStatus {
    const status = this.channel.status(hostId); if (status === undefined) return fail('terminal peer was not found');
    if (!status.capabilities.includes(capability)) return fail('terminal attach capability is unavailable');
    if (status.state !== 'online' && status.state !== 'degraded') return fail(`terminal peer is ${status.state}`);
    return status;
  }
  private call(call: RemoteTerminalCall): Promise<JsonValue> {
    const { target, operation, body, generation, deadlineAtMs } = call;
    if (deadlineAtMs <= this.now()) return Promise.reject(new RemoteTerminalClientError('terminal deadline exceeded'));
    const requestId = `terminal-${randomUUID()}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new RemoteTerminalClientError('terminal deadline exceeded')); }, deadlineAtMs - this.now()); timer.unref();
      this.pending.set(requestId, { hostId: target.hostId, generation, resolve, reject, timer });
      const frame: FleetRequestEnvelope = { kind: 'request', protocolVersion: FLEET_PROTOCOL_VERSION, connectionGeneration: generation, requestId, operation, target, body };
      if (!this.channel.send(target.hostId, frame)) { clearTimeout(timer); this.pending.delete(requestId); reject(new RemoteTerminalClientError('terminal peer disconnected before dispatch')); }
    });
  }
  private frame(hostId: string, frame: FleetProtocolFrame): void {
    if (frame.kind === 'response') {
      const pending = this.pending.get(frame.requestId); if (pending === undefined || pending.hostId !== hostId || pending.generation !== frame.connectionGeneration) return;
      clearTimeout(pending.timer); this.pending.delete(frame.requestId);
      if (frame.status === 'success') pending.resolve(frame.body); else pending.reject(new RemoteTerminalClientError(frame.error));
      return;
    }
    if (frame.kind !== 'event' || frame.event !== 'pane.output' || frame.hostId !== hostId) return;
    const output = record(frame.body); const sessionId = text(output.terminalSessionId, 'terminal session id'); const streamEpoch = text(output.streamEpoch, 'stream epoch');
    const leaseToken = text(output.leaseToken, 'terminal lease token');
    const identityKey = [hostId, sessionId, streamEpoch].join('\0');
    const leaseKey = ['lease', leaseToken].join('\0');
    const key = this.active.has(identityKey) ? identityKey : leaseKey;
    const active = this.active.get(key); if (active === undefined || (active.streamEpoch !== '' && active.streamEpoch !== streamEpoch) || frame.connectionGeneration !== active.lease.connectionGeneration || output.peerProcessEpoch !== active.peerProcessEpoch) return;
    const data = text(output.data, 'terminal output');
    // Equality is permitted; only a payload that would exceed the exact byte bound is rejected.
    if (active.sink.bufferedAmount + Buffer.byteLength(data) > this.maxBufferedBytes) {
      this.sendClose(active); this.active.delete(key); active.sink.close('slow_consumer'); return;
    }
    active.sink.output(data, integer(output.seq, 'output sequence'), output.replay === true);
  }
  private resumeKey(hostId: string, identity: RemoteTerminalResume): string {
    return [hostId, identity.peerProcessEpoch, identity.terminalSessionId, identity.streamEpoch].join('\0');
  }
  private sendClose(active: Active): void {
    const deadlineAtMs = this.now() + 10_000;
    this.channel.send(active.target.hostId, {
      kind: 'request', protocolVersion: FLEET_PROTOCOL_VERSION, connectionGeneration: active.lease.connectionGeneration,
      requestId: 'terminal-close-' + randomUUID(), operation: 'pane.escape', target: active.target,
      body: { deadlineAtMs, lease: active.lease, streamEpoch: active.streamEpoch, action: 'close' },
    });
  }
  private status(status: HubPeerStatus): void {
    for (const [requestId, pending] of this.pending) {
      if (pending.hostId !== status.peerId || ((status.state === 'online' || status.state === 'degraded') && status.generation === pending.generation)) continue;
      clearTimeout(pending.timer); this.pending.delete(requestId); pending.reject(new RemoteTerminalClientError(status.state === 'revoked' ? 'terminal peer is revoked' : 'terminal peer disconnected'));
    }
    for (const [key, active] of this.active) {
      if (active.target.hostId !== status.peerId || ((status.state === 'online' || status.state === 'degraded') && status.generation === active.lease.connectionGeneration)) continue;
      this.active.delete(key); active.sink.close(status.state === 'revoked' ? 'revoked' : 'disconnected');
    }
    for (const [key, recordValue] of this.resumeLeases) {
      if (recordValue.target.hostId === status.peerId && recordValue.lease.connectionGeneration !== status.generation) this.resumeLeases.delete(key);
      else if (recordValue.target.hostId === status.peerId && status.state !== 'online' && status.state !== 'degraded') this.resumeLeases.delete(key);
    }
  }
}
