import type { FleetPaneReference, FleetRequestEnvelope, JsonValue } from '../../../../../shared/fleet.js';
import type { PeerOperationHandlers } from '../../peer/operation-dispatcher.js';

import { FleetMutationContractError, parseFleetMutationRequest, type ApprovalDecision, type FleetMutationRequest, type PromptResponse } from './contracts.js';
import { FleetMutationRpcError } from './errors.js';

export type MutationActionTarget = Readonly<{ readonly token: string }>;
export type VerifiedSpawn = Readonly<{ readonly cwd: string }>;
export type FleetMutationServices = Readonly<{
  readonly verifySession: (localId: string) => Promise<MutationActionTarget>;
  readonly verifyPane: (target: FleetPaneReference) => Promise<MutationActionTarget>;
  readonly verifySpawn: (projectLocalId: string, cwd: string) => Promise<VerifiedSpawn>;
  readonly finalCheck: (request: FleetMutationRequest, target: MutationActionTarget | VerifiedSpawn) => Promise<void>;
  readonly send: (target: MutationActionTarget, message: string) => Promise<void>;
  readonly abort: (target: MutationActionTarget) => Promise<void>;
  readonly interrupt: (target: MutationActionTarget) => Promise<void>;
  readonly escape: (target: MutationActionTarget) => Promise<void>;
  readonly respondPrompt: (target: MutationActionTarget, response: PromptResponse) => Promise<JsonValue>;
  readonly respondApproval: (target: MutationActionTarget, decision: ApprovalDecision) => Promise<void>;
  readonly spawn: (target: VerifiedSpawn, name: string) => Promise<JsonValue>;
  readonly terminateProcess: (target: MutationActionTarget) => Promise<void>;
  readonly terminatePane: (target: MutationActionTarget) => Promise<void>;
  readonly terminateSession: (target: MutationActionTarget) => Promise<void>;
}>;
function deadline(request: FleetMutationRequest, now: () => number): void { if (request.body.deadlineAtMs <= now()) throw new FleetMutationRpcError('FLEET_DEADLINE_EXCEEDED', 'mutation deadline exceeded'); }
async function authorize(request: FleetMutationRequest, target: MutationActionTarget | VerifiedSpawn, services: FleetMutationServices, now: () => number): Promise<void> {
  deadline(request, now);
  await services.finalCheck(request, target);
  deadline(request, now);
}
async function execute(request: FleetMutationRequest, services: FleetMutationServices, now: () => number): Promise<JsonValue> {
  switch (request.operation) {
    case 'session.spawn': { const verified = await services.verifySpawn(request.target.localId, request.body.cwd); await authorize(request, verified, services, now); return services.spawn(verified, request.body.name); }
    case 'chat.send': { const verified = await services.verifySession(request.target.localId); await authorize(request, verified, services, now); await services.send(verified, request.body.message); return { ok: true }; }
    case 'chat.abort': { const verified = await services.verifySession(request.target.localId); await authorize(request, verified, services, now); await services.abort(verified); return { ok: true }; }
    case 'prompt.respond': { const verified = await services.verifySession(request.target.localId); await authorize(request, verified, services, now); return services.respondPrompt(verified, request.body); }
    case 'approval.respond': { const verified = await services.verifySession(request.target.localId); await authorize(request, verified, services, now); await services.respondApproval(verified, request.body.decision); return { ok: true }; }
    case 'pane.input': { const verified = await services.verifyPane(request.target); await authorize(request, verified, services, now); await services.send(verified, request.body.message); return { ok: true }; }
    case 'pane.interrupt': { const verified = await services.verifyPane(request.target); await authorize(request, verified, services, now); await services.interrupt(verified); return { ok: true }; }
    case 'pane.escape': { const verified = await services.verifyPane(request.target); await authorize(request, verified, services, now); await services.escape(verified); return { ok: true }; }
    case 'process.terminate': { const verified = await services.verifyPane(request.target); await authorize(request, verified, services, now); await services.terminateProcess(verified); return { ok: true }; }
    case 'pane.terminate': { const verified = await services.verifyPane(request.target); await authorize(request, verified, services, now); await services.terminatePane(verified); return { ok: true }; }
    case 'session.terminate': { const verified = await services.verifyPane(request.target); await authorize(request, verified, services, now); await services.terminateSession(verified); return { ok: true }; }
  }
}
export function createFleetMutationHandlers(localHostId: string, services: FleetMutationServices, now: () => number = Date.now): PeerOperationHandlers {
  const handle = async (request: FleetRequestEnvelope): Promise<JsonValue> => {
    if (request.target.hostId !== localHostId) throw new FleetMutationRpcError('HOST_NOT_FOUND', 'mutation target belongs to another host');
    try { const parsed = parseFleetMutationRequest(request); deadline(parsed, now); return await execute(parsed, services, now); }
    catch (error) { if (error instanceof FleetMutationContractError) throw new FleetMutationRpcError('FLEET_MALFORMED_FRAME', error.message); throw error; }
  };
  return { 'chat.send': handle, 'chat.abort': handle, 'pane.input': handle, 'pane.interrupt': handle, 'pane.escape': handle, 'prompt.respond': handle, 'approval.respond': handle, 'session.spawn': handle, 'process.terminate': handle, 'pane.terminate': handle, 'session.terminate': handle };
}
