import { FLEET_PROTOCOL_VERSION, type FleetCapability, type FleetErrorCode, type FleetOperation, type FleetPaneReference, type FleetProjectReference, type FleetRequestEnvelope, type FleetSessionReference, type JsonValue } from '../../../../../shared/fleet.js';
import type { HubPeerStatus } from '../../hub/connection/types.js';
import { capabilityForOperation } from '../../protocol/capabilities.js';
import type { FleetProtocolFrame } from '../../protocol/types.js';

import type { ApprovalDecision, PromptResponse } from './contracts.js';

export interface FleetMutationChannel {
  status(hostId: string): HubPeerStatus | undefined;
  send(hostId: string, frame: FleetProtocolFrame): boolean;
  subscribeFrames(listener: (hostId: string, frame: FleetProtocolFrame) => void): () => void;
  subscribeStatus(listener: (status: HubPeerStatus) => void): () => void;
}
export type MutationOutcomeStatus = 'unknown' | 'resolved_applied' | 'resolved_not_applied';
export class FleetUnknownMutationOutcome {
  private value: MutationOutcomeStatus = 'unknown';
  constructor(readonly requestId: string) {}
  get status(): MutationOutcomeStatus { return this.value; }
  async reconcile(readEvidence: () => Promise<'applied' | 'not_applied'>): Promise<MutationOutcomeStatus> {
    if (this.value !== 'unknown') return this.value;
    const evidence = await readEvidence();
    if (this.value === 'unknown') this.value = evidence === 'applied' ? 'resolved_applied' : 'resolved_not_applied';
    return this.value;
  }
}
export class FleetMutationClientError extends Error {
  readonly name = 'FleetMutationClientError';
  constructor(readonly code: FleetErrorCode, message: string, readonly sideEffect: 'none' | 'possible', readonly outcome: FleetUnknownMutationOutcome | null = null) { super(message); }
}
type MutationOperation = Extract<FleetOperation, 'chat.send' | 'chat.abort' | 'prompt.respond' | 'approval.respond' | 'pane.input' | 'pane.interrupt' | 'pane.escape' | 'session.spawn' | 'process.terminate' | 'pane.terminate' | 'session.terminate'>;
type MutationTarget = FleetSessionReference | FleetProjectReference | FleetPaneReference;
export type MutationMeta = Readonly<{ readonly requestId: string; readonly deadlineAtMs: number }>;
type MutationCall = Readonly<{ readonly operation: MutationOperation; readonly target: MutationTarget; readonly body: JsonValue; readonly meta: MutationMeta; readonly generation: number }>;

function blocked(status: HubPeerStatus | undefined, capability: FleetCapability): FleetMutationClientError | null {
  if (status === undefined) return new FleetMutationClientError('HOST_NOT_FOUND', 'fleet host was not found', 'none');
  if (!status.capabilities.includes(capability)) return new FleetMutationClientError('FLEET_CAPABILITY_UNAVAILABLE', 'mutation capability is unavailable', 'none');
  switch (status.state) {
    case 'online': case 'degraded': return status.generation === null ? new FleetMutationClientError('HOST_SYNCING', 'fleet host is synchronizing', 'none') : null;
    case 'connecting': case 'syncing': return new FleetMutationClientError('HOST_SYNCING', 'fleet host is synchronizing', 'none');
    case 'offline': return new FleetMutationClientError('HOST_OFFLINE', 'fleet host is offline', 'none');
    case 'revoked': return new FleetMutationClientError('HOST_REVOKED', 'fleet host is revoked', 'none');
    case 'incompatible': return new FleetMutationClientError('HOST_INCOMPATIBLE', 'fleet host is incompatible', 'none');
  }
}
function envelope(call: MutationCall): FleetRequestEnvelope {
  const base = { kind: 'request' as const, protocolVersion: FLEET_PROTOCOL_VERSION, connectionGeneration: call.generation, requestId: call.meta.requestId, body: call.body };
  switch (call.operation) {
    case 'chat.send': case 'chat.abort': case 'prompt.respond': case 'approval.respond':
      if (call.target.kind !== 'session') throw new FleetMutationClientError('FLEET_MALFORMED_FRAME', 'session mutation target is invalid', 'none');
      return { ...base, operation: call.operation, target: call.target };
    case 'session.spawn':
      if (call.target.kind !== 'project') throw new FleetMutationClientError('FLEET_MALFORMED_FRAME', 'spawn target is invalid', 'none');
      return { ...base, operation: call.operation, target: call.target };
    case 'pane.input': case 'pane.interrupt': case 'pane.escape': case 'process.terminate': case 'pane.terminate': case 'session.terminate':
      if (call.target.kind !== 'pane') throw new FleetMutationClientError('FLEET_MALFORMED_FRAME', 'pane mutation target is invalid', 'none');
      return { ...base, operation: call.operation, target: call.target };
  }
}
export class FleetMutationClient {
  constructor(private readonly channel: FleetMutationChannel) {}
  sendChat(target: FleetSessionReference, input: MutationMeta & Readonly<{ readonly message: string }>): Promise<JsonValue> { return this.call('chat.send', target, { deadlineAtMs: input.deadlineAtMs, message: input.message }, input); }
  abortChat(target: FleetSessionReference, meta: MutationMeta): Promise<JsonValue> { return this.call('chat.abort', target, { deadlineAtMs: meta.deadlineAtMs }, meta); }
  sendPane(target: FleetPaneReference, input: MutationMeta & Readonly<{ readonly message: string }>): Promise<JsonValue> { return this.call('pane.input', target, { deadlineAtMs: input.deadlineAtMs, message: input.message }, input); }
  interrupt(target: FleetPaneReference, meta: MutationMeta): Promise<JsonValue> { return this.call('pane.interrupt', target, { deadlineAtMs: meta.deadlineAtMs }, meta); }
  escape(target: FleetPaneReference, meta: MutationMeta): Promise<JsonValue> { return this.call('pane.escape', target, { deadlineAtMs: meta.deadlineAtMs }, meta); }
  respondPrompt(target: FleetSessionReference, input: MutationMeta & PromptResponse): Promise<JsonValue> {
    if (input.response === 'choices') return this.call('prompt.respond', target, { deadlineAtMs: input.deadlineAtMs, response: input.response, promptId: input.promptId, choices: input.choices }, input);
    return this.call('prompt.respond', target, { deadlineAtMs: input.deadlineAtMs, response: input.response, promptId: input.promptId, message: input.message }, input);
  }
  respondApproval(target: FleetSessionReference, input: MutationMeta & Readonly<{ readonly decision: ApprovalDecision }>): Promise<JsonValue> { return this.call('approval.respond', target, { deadlineAtMs: input.deadlineAtMs, decision: input.decision }, input); }
  spawn(target: FleetProjectReference, input: MutationMeta & Readonly<{ readonly name: string; readonly cwd: string }>): Promise<JsonValue> { return this.call('session.spawn', target, { deadlineAtMs: input.deadlineAtMs, name: input.name, cwd: input.cwd }, input); }
  terminateProcess(target: FleetPaneReference, meta: MutationMeta): Promise<JsonValue> { return this.call('process.terminate', target, { deadlineAtMs: meta.deadlineAtMs }, meta); }
  terminatePane(target: FleetPaneReference, meta: MutationMeta): Promise<JsonValue> { return this.call('pane.terminate', target, { deadlineAtMs: meta.deadlineAtMs }, meta); }
  terminateSession(target: FleetPaneReference, meta: MutationMeta): Promise<JsonValue> { return this.call('session.terminate', target, { deadlineAtMs: meta.deadlineAtMs }, meta); }
  private call(operation: MutationOperation, target: MutationTarget, body: JsonValue, meta: MutationMeta): Promise<JsonValue> {
    const status = this.channel.status(target.hostId); const denied = blocked(status, capabilityForOperation(operation));
    if (denied !== null) return Promise.reject(denied);
    if (status?.generation === null || status?.generation === undefined) return Promise.reject(new FleetMutationClientError('HOST_SYNCING', 'fleet host is synchronizing', 'none'));
    if (meta.deadlineAtMs <= Date.now()) return Promise.reject(new FleetMutationClientError('FLEET_DEADLINE_EXCEEDED', 'mutation deadline exceeded', 'none'));
    return this.awaitOutcome({ operation, target, body, meta, generation: status.generation });
  }
  private awaitOutcome(call: MutationCall): Promise<JsonValue> {
    return new Promise((resolve, reject) => {
      let settled = false; let dispatched = false;
      const release = (): void => { clearTimeout(timer); releaseFrames(); releaseStatus(); };
      const fail = (error: FleetMutationClientError): void => { if (settled) return; settled = true; release(); reject(error); };
      const releaseFrames = this.channel.subscribeFrames((hostId, frame) => {
        if (hostId !== call.target.hostId || frame.kind !== 'response' || frame.requestId !== call.meta.requestId || frame.connectionGeneration !== call.generation) return;
        if (settled) return; settled = true; release();
        if (frame.status === 'success') resolve(frame.body); else reject(new FleetMutationClientError(frame.error, 'fleet mutation failed', frame.sideEffect));
      });
      const releaseStatus = this.channel.subscribeStatus((status) => {
        if (status.peerId !== call.target.hostId || settled || !dispatched) return;
        if (status.state !== 'online' && status.state !== 'degraded' || status.generation !== call.generation) fail(new FleetMutationClientError('HOST_COMMAND_OUTCOME_UNKNOWN', 'fleet mutation outcome is unknown', 'possible', new FleetUnknownMutationOutcome(call.meta.requestId)));
      });
      const timer = setTimeout(() => fail(new FleetMutationClientError(dispatched ? 'HOST_COMMAND_OUTCOME_UNKNOWN' : 'FLEET_DEADLINE_EXCEEDED', dispatched ? 'fleet mutation outcome is unknown' : 'mutation deadline exceeded', dispatched ? 'possible' : 'none', dispatched ? new FleetUnknownMutationOutcome(call.meta.requestId) : null)), call.meta.deadlineAtMs - Date.now()); timer.unref();
      dispatched = true;
      if (!this.channel.send(call.target.hostId, envelope(call))) {
        dispatched = false;
        fail(new FleetMutationClientError('HOST_OFFLINE', 'fleet host disconnected before dispatch', 'none'));
      }
    });
  }
}
