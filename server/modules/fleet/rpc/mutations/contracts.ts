import type { FleetPaneReference, FleetProjectReference, FleetRequestEnvelope, FleetSessionReference, JsonValue } from '../../../../../shared/fleet.js';

type Base<TTarget, TBody> = Omit<FleetRequestEnvelope, 'operation' | 'target' | 'body'> & Readonly<{ readonly target: TTarget; readonly body: TBody }>;
type Deadline = Readonly<{ readonly deadlineAtMs: number }>;
export type PromptResponse =
  | Readonly<{ readonly response: 'choices'; readonly promptId: string; readonly choices: readonly number[] }>
  | Readonly<{ readonly response: 'custom'; readonly promptId: string; readonly message: string }>;
export type ApprovalDecision = 'approve-once' | 'approve-remember' | 'reject' | 'cancel';
export type FleetMutationRequest =
  | (Base<FleetSessionReference, Deadline & Readonly<{ readonly message: string }>> & Readonly<{ readonly operation: 'chat.send' }>)
  | (Base<FleetSessionReference, Deadline> & Readonly<{ readonly operation: 'chat.abort' }>)
  | (Base<FleetPaneReference, Deadline & Readonly<{ readonly message: string }>> & Readonly<{ readonly operation: 'pane.input' }>)
  | (Base<FleetPaneReference, Deadline> & Readonly<{ readonly operation: 'pane.interrupt' | 'pane.escape' | 'process.terminate' | 'pane.terminate' | 'session.terminate' }>)
  | (Base<FleetSessionReference, Deadline & PromptResponse> & Readonly<{ readonly operation: 'prompt.respond' }>)
  | (Base<FleetSessionReference, Deadline & Readonly<{ readonly decision: ApprovalDecision }>> & Readonly<{ readonly operation: 'approval.respond' }>)
  | (Base<FleetProjectReference, Deadline & Readonly<{ readonly name: string; readonly cwd: string }>> & Readonly<{ readonly operation: 'session.spawn' }>);

export class FleetMutationContractError extends Error { readonly name = 'FleetMutationContractError'; }
function fail(message: string): never { throw new FleetMutationContractError(message); }
function isRecord(value: JsonValue): value is Readonly<Record<string, JsonValue>> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function record(value: JsonValue): Readonly<Record<string, JsonValue>> { return isRecord(value) ? value : fail('mutation body must be an object'); }
function exact(value: Readonly<Record<string, JsonValue>>, fields: readonly string[]): void { const keys = Object.keys(value); if (keys.length !== fields.length || keys.some((key) => !fields.includes(key))) fail('mutation body has unexpected fields'); }
function deadline(value: JsonValue | undefined): number { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fail('deadlineAtMs is invalid'); }
function text(value: JsonValue | undefined, name: string, maximum: number): string { return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum && !value.includes('\0') ? value : fail(`${name} is invalid`); }
function simple(body: JsonValue): Deadline { const input = record(body); exact(input, ['deadlineAtMs']); return { deadlineAtMs: deadline(input.deadlineAtMs) }; }
function message(body: JsonValue): Deadline & Readonly<{ readonly message: string }> { const input = record(body); exact(input, ['deadlineAtMs', 'message']); return { deadlineAtMs: deadline(input.deadlineAtMs), message: text(input.message, 'message', 100_000) }; }
function prompt(body: JsonValue): Deadline & PromptResponse {
  const input = record(body); const deadlineAtMs = deadline(input.deadlineAtMs); const promptId = text(input.promptId, 'promptId', 128);
  if (input.response === 'choices') {
    exact(input, ['deadlineAtMs', 'response', 'promptId', 'choices']);
    if (!Array.isArray(input.choices) || input.choices.length < 1 || input.choices.length > 32 || input.choices.some((choice) => typeof choice !== 'number' || !Number.isInteger(choice) || choice < 0 || choice > 32)) fail('choices are invalid');
    return { deadlineAtMs, response: input.response, promptId, choices: input.choices };
  }
  if (input.response === 'custom') { exact(input, ['deadlineAtMs', 'response', 'promptId', 'message']); return { deadlineAtMs, response: input.response, promptId, message: text(input.message, 'message', 100_000) }; }
  return fail('prompt response kind is invalid');
}
function approval(body: JsonValue): Deadline & Readonly<{ readonly decision: ApprovalDecision }> {
  const input = record(body); exact(input, ['deadlineAtMs', 'decision']);
  if (input.decision !== 'approve-once' && input.decision !== 'approve-remember' && input.decision !== 'reject' && input.decision !== 'cancel') return fail('approval decision is invalid');
  return { deadlineAtMs: deadline(input.deadlineAtMs), decision: input.decision };
}
function spawn(body: JsonValue): Deadline & Readonly<{ readonly name: string; readonly cwd: string }> { const input = record(body); exact(input, ['deadlineAtMs', 'name', 'cwd']); return { deadlineAtMs: deadline(input.deadlineAtMs), name: text(input.name, 'name', 64), cwd: text(input.cwd, 'cwd', 512) }; }
export function parseFleetMutationRequest(request: FleetRequestEnvelope): FleetMutationRequest {
  switch (request.operation) {
    case 'chat.send': return { ...request, operation: request.operation, target: request.target, body: message(request.body) };
    case 'chat.abort': return { ...request, operation: request.operation, target: request.target, body: simple(request.body) };
    case 'pane.input': return { ...request, operation: request.operation, target: request.target, body: message(request.body) };
    case 'pane.interrupt': case 'pane.escape': case 'process.terminate': case 'pane.terminate': case 'session.terminate': return { ...request, operation: request.operation, target: request.target, body: simple(request.body) };
    case 'prompt.respond': return { ...request, operation: request.operation, target: request.target, body: prompt(request.body) };
    case 'approval.respond': return { ...request, operation: request.operation, target: request.target, body: approval(request.body) };
    case 'session.spawn': return { ...request, operation: request.operation, target: request.target, body: spawn(request.body) };
    default: return fail('operation is not a mutation');
  }
}
