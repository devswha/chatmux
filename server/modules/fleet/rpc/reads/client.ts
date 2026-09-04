import { randomUUID } from 'node:crypto';

import {
  FLEET_PROTOCOL_VERSION,
  type FleetCapability,
  type FleetErrorCode,
  type FleetOperation,
  type FleetPaneReference,
  type FleetProjectReference,
  type FleetRequestEnvelope,
  type FleetSessionReference,
  type JsonValue,
} from '../../../../../shared/fleet.js';
import { capabilityForOperation } from '../../protocol/capabilities.js';
import { canonicalFleetJson } from '../../protocol/codec.js';
import type { FleetProtocolFrame } from '../../protocol/types.js';
import type { HubPeerStatus } from '../../hub/connection/types.js';

import type { HistoryRead } from './contracts.js';

export interface FleetReadChannel {
  status(hostId: string): HubPeerStatus | undefined;
  send(hostId: string, frame: FleetProtocolFrame): boolean;
  subscribeFrames(listener: (hostId: string, frame: FleetProtocolFrame) => void): () => void;
  subscribeStatus(listener: (status: HubPeerStatus) => void): () => void;
}

export class FleetReadClientError extends Error {
  readonly name = 'FleetReadClientError';
  constructor(readonly code: FleetErrorCode, message: string) { super(message); }
}

type ReadOperation = Extract<FleetOperation,
  'session.read' | 'session.history' | 'session.search' | 'prompt.read' | 'approval.read' | 'pane.capture'
>;
type ReadTarget = FleetSessionReference | FleetProjectReference | FleetPaneReference;
type SearchOptions = Readonly<{ readonly deadlineAtMs: number; readonly query: string; readonly limit: number }>;
type SuggestionOptions = Readonly<{ readonly deadlineAtMs: number; readonly prefix: string }>;
type ReadCall = Readonly<{ readonly operation: ReadOperation; readonly target: ReadTarget; readonly body: JsonValue; readonly initialGeneration: number; readonly deadlineAtMs: number }>;

function admission(status: HubPeerStatus | undefined, capability: FleetCapability): FleetReadClientError | null {
  if (status === undefined) return new FleetReadClientError('HOST_NOT_FOUND', 'fleet host was not found');
  if (!status.capabilities.includes(capability)) return new FleetReadClientError('FLEET_CAPABILITY_UNAVAILABLE', 'fleet read capability is unavailable');
  switch (status.state) {
    case 'online': case 'degraded': return status.generation === null ? new FleetReadClientError('HOST_SYNCING', 'fleet host is synchronizing') : null;
    case 'connecting': case 'syncing': return new FleetReadClientError('HOST_SYNCING', 'fleet host is synchronizing');
    case 'offline': return new FleetReadClientError('HOST_OFFLINE', 'fleet host is offline');
    case 'revoked': return new FleetReadClientError('HOST_REVOKED', 'fleet host is revoked');
    case 'incompatible': return new FleetReadClientError('HOST_INCOMPATIBLE', 'fleet host is incompatible');
  }
}

function isJsonRecord(value: JsonValue): value is Readonly<Record<string, JsonValue>> {
  return value !== null && !Array.isArray(value) && typeof value === 'object';
}
function deadlineFrom(body: JsonValue): number {
  if (isJsonRecord(body) && typeof body.deadlineAtMs === 'number') return body.deadlineAtMs;
  throw new FleetReadClientError('FLEET_MALFORMED_FRAME', 'fleet read deadline is missing');
}
function envelope(call: ReadCall, generation: number, requestId: string): FleetRequestEnvelope {
  const base = { kind: 'request' as const, protocolVersion: FLEET_PROTOCOL_VERSION, connectionGeneration: generation, requestId, body: call.body };
  switch (call.operation) {
    case 'session.read': case 'session.history': case 'prompt.read': case 'approval.read':
      if (call.target.kind !== 'session') throw new FleetReadClientError('FLEET_MALFORMED_FRAME', 'session read target is invalid');
      return { ...base, operation: call.operation, target: call.target };
    case 'session.search':
      if (call.target.kind !== 'project') throw new FleetReadClientError('FLEET_MALFORMED_FRAME', 'project read target is invalid');
      return { ...base, operation: call.operation, target: call.target };
    case 'pane.capture':
      if (call.target.kind !== 'pane') throw new FleetReadClientError('FLEET_MALFORMED_FRAME', 'pane read target is invalid');
      return { ...base, operation: call.operation, target: call.target };
  }
}

export class FleetReadClient {
  constructor(private readonly channel: FleetReadChannel) {}

  metadata(target: FleetSessionReference, deadlineAtMs: number): Promise<JsonValue> { return this.call('session.read', target, { read: 'metadata', deadlineAtMs }); }
  toolResult(target: FleetSessionReference, options: Readonly<{ toolId: string; offset: number; revision: string | null; deadlineAtMs: number }>): Promise<JsonValue> {
    return this.call('session.read', target, { read: 'tool_result', ...options });
  }
  providerInventory(target: FleetSessionReference, deadlineAtMs: number): Promise<JsonValue> { return this.call('session.read', target, { read: 'provider_inventory', deadlineAtMs }); }
  chatSubscription(target: FleetSessionReference, deadlineAtMs: number, lastSeq: number): Promise<JsonValue> {
    return this.call('session.read', target, { read: 'chat_subscription', deadlineAtMs, lastSeq });
  }
  history(target: FleetSessionReference, options: HistoryRead): Promise<JsonValue> { return this.call('session.history', target, options); }
  search(target: FleetProjectReference, options: SearchOptions): Promise<JsonValue> { return this.call('session.search', target, { read: 'transcript_search', ...options }); }
  pathSuggestions(target: FleetProjectReference, options: SuggestionOptions): Promise<JsonValue> { return this.call('session.search', target, { read: 'path_suggestions', ...options }); }
  prompt(target: FleetSessionReference, deadlineAtMs: number): Promise<JsonValue> { return this.call('prompt.read', target, { deadlineAtMs }); }
  approval(target: FleetSessionReference, deadlineAtMs: number): Promise<JsonValue> { return this.call('approval.read', target, { deadlineAtMs }); }
  capturePane(target: FleetPaneReference, deadlineAtMs: number): Promise<JsonValue> { return this.call('pane.capture', target, { deadlineAtMs }); }

  private call(operation: ReadOperation, target: ReadTarget, body: JsonValue): Promise<JsonValue> {
    const status = this.channel.status(target.hostId);
    const blocked = admission(status, capabilityForOperation(operation));
    if (blocked !== null) return Promise.reject(blocked);
    if (status?.generation === null || status?.generation === undefined) return Promise.reject(new FleetReadClientError('HOST_SYNCING', 'fleet host is synchronizing'));
    const deadlineAtMs = deadlineFrom(body);
    if (deadlineAtMs <= Date.now()) return Promise.reject(new FleetReadClientError('FLEET_DEADLINE_EXCEEDED', 'fleet read deadline exceeded'));
    return this.awaitResponse({ operation, target, body, initialGeneration: status.generation, deadlineAtMs });
  }

  private awaitResponse(call: ReadCall): Promise<JsonValue> {
    return new Promise((resolve, reject) => {
      const requestId = `read-${randomUUID()}`;
      let expectedGeneration = call.initialGeneration;
      let retryUsed = false;
      let disconnected = false;
      let settled = false;
      const release = (): void => { clearTimeout(timer); releaseFrames(); releaseStatus(); };
      const finish = (outcome: Readonly<{ readonly value: JsonValue }> | Readonly<{ readonly error: FleetReadClientError }>): void => {
        if (settled) return; settled = true; release();
        if ('value' in outcome) resolve(outcome.value); else reject(outcome.error);
      };
      const send = (): void => {
        const request = envelope(call, expectedGeneration, requestId);
        if (!this.channel.send(call.target.hostId, request)) disconnected = true;
      };
      const releaseFrames = this.channel.subscribeFrames((hostId, frame) => {
        if (hostId !== call.target.hostId || frame.kind !== 'response' || frame.requestId !== requestId || frame.connectionGeneration !== expectedGeneration) return;
        if (canonicalFleetJson(frame.target) !== canonicalFleetJson(call.target)) {
          finish({ error: new FleetReadClientError('FLEET_MALFORMED_FRAME', 'fleet response target does not match the request') });
          return;
        }
        if (frame.status === 'success') finish({ value: frame.body });
        else finish({ error: new FleetReadClientError(frame.error, 'fleet read failed') });
      });
      const releaseStatus = this.channel.subscribeStatus((next) => {
        if (next.peerId !== call.target.hostId || settled) return;
        if (next.state === 'offline' || next.state === 'connecting' || next.state === 'syncing') disconnected = true;
        if (!disconnected || retryUsed || next.state !== 'online' || next.generation === null || next.generation === call.initialGeneration) return;
        if (call.deadlineAtMs <= Date.now()) { finish({ error: new FleetReadClientError('FLEET_DEADLINE_EXCEEDED', 'fleet read deadline exceeded') }); return; }
        retryUsed = true; expectedGeneration = next.generation; send();
      });
      const timer = setTimeout(() => finish({ error: new FleetReadClientError('FLEET_DEADLINE_EXCEEDED', 'fleet read deadline exceeded') }), call.deadlineAtMs - Date.now());
      timer.unref();
      send();
    });
  }
}
