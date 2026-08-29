import { AppError } from '@/shared/utils.js';

import {
  FLEET_CAPABILITIES,
  type FleetCapability,
  type FleetEvent,
  type FleetOperation,
  type FleetRequestEnvelope,
  type FleetResponseEnvelope,
  type JsonValue,
} from '../../../../shared/fleet.js';
import { FleetMutationRpcError } from '../rpc/mutations/errors.js';
import { FleetReadRpcError } from '../rpc/reads/errors.js';
import { RemoteTerminalContractError } from '../terminal/contracts.js';
import { RemoteTerminalPeerError } from '../terminal/peer.js';

export type PeerOperationHandler = (request: FleetRequestEnvelope) => Promise<JsonValue>;
export type PeerOperationHandlers = Readonly<Partial<Record<FleetOperation, PeerOperationHandler>>>;

const OPERATIONS_BY_CAPABILITY = {
  'catalog.read': ['catalog.snapshot'],
  'session.read': ['session.read', 'session.history', 'session.search'],
  'chat.control': ['chat.send', 'chat.abort'],
  'prompt.respond': ['prompt.read', 'prompt.respond', 'approval.read', 'approval.respond'],
  'pane.read': ['pane.capture'],
  'terminal.attach': ['pane.attach'],
  'terminal.input': ['pane.input', 'pane.resize', 'pane.interrupt', 'pane.escape'],
  'session.spawn': ['session.spawn'],
  'session.terminate': ['pane.terminate', 'process.terminate', 'session.terminate'],
  'completion.event': [],
} as const satisfies Readonly<Record<FleetCapability, readonly FleetOperation[]>>;

const EVENTS_BY_CAPABILITY = {
  'catalog.read': ['catalog.snapshot', 'catalog.delta', 'host.state'],
  'session.read': [],
  'chat.control': ['chat.delta'],
  'prompt.respond': ['prompt.changed', 'approval.changed'],
  'pane.read': ['pane.output'],
  'terminal.attach': [],
  'terminal.input': [],
  'session.spawn': [],
  'session.terminate': [],
  'completion.event': ['completion.ready'],
} as const satisfies Readonly<Record<FleetCapability, readonly FleetEvent[]>>;

const FORBIDDEN_FIELDS = new Set(['argv', 'path', 'method', 'route', 'controller']);

function containsForbiddenField(value: JsonValue): boolean {
  if (Array.isArray(value)) return value.some(containsForbiddenField);
  if (value === null || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, item]) => FORBIDDEN_FIELDS.has(key) || containsForbiddenField(item));
}

function handlerFor(
  handlers: PeerOperationHandlers,
  operation: FleetOperation,
): PeerOperationHandler | undefined {
  switch (operation) {
    case 'catalog.snapshot': return handlers['catalog.snapshot'];
    case 'session.read': return handlers['session.read'];
    case 'session.history': return handlers['session.history'];
    case 'session.search': return handlers['session.search'];
    case 'chat.send': return handlers['chat.send'];
    case 'chat.abort': return handlers['chat.abort'];
    case 'prompt.read': return handlers['prompt.read'];
    case 'prompt.respond': return handlers['prompt.respond'];
    case 'approval.read': return handlers['approval.read'];
    case 'approval.respond': return handlers['approval.respond'];
    case 'pane.capture': return handlers['pane.capture'];
    case 'pane.attach': return handlers['pane.attach'];
    case 'pane.input': return handlers['pane.input'];
    case 'pane.resize': return handlers['pane.resize'];
    case 'pane.interrupt': return handlers['pane.interrupt'];
    case 'pane.escape': return handlers['pane.escape'];
    case 'pane.terminate': return handlers['pane.terminate'];
    case 'process.terminate': return handlers['process.terminate'];
    case 'session.spawn': return handlers['session.spawn'];
    case 'session.terminate': return handlers['session.terminate'];
  }
}

export function derivePeerCapabilities(
  handlers: PeerOperationHandlers,
  events: readonly FleetEvent[],
): readonly FleetCapability[] {
  return FLEET_CAPABILITIES.filter((capability) => {
    const operations = OPERATIONS_BY_CAPABILITY[capability];
    const eventTypes = EVENTS_BY_CAPABILITY[capability];
    const operationsAvailable = operations.length > 0
      && operations.every((operation) => handlerFor(handlers, operation) !== undefined);
    const eventAvailable = eventTypes.some((event) => events.includes(event));
    return operationsAvailable || eventAvailable;
  });
}

function sideEffectFor(operation: FleetOperation): 'none' | 'applied' {
  switch (operation) {
    case 'catalog.snapshot': case 'session.read': case 'session.history': case 'session.search': case 'prompt.read': case 'approval.read': case 'pane.capture': return 'none';
    case 'chat.send': case 'chat.abort': case 'prompt.respond': case 'approval.respond': case 'pane.attach': case 'pane.input': case 'pane.resize': case 'pane.interrupt': case 'pane.escape': case 'pane.terminate': case 'process.terminate': case 'session.spawn': case 'session.terminate': return 'applied';
  }
}

function failure(
  request: FleetRequestEnvelope,
  error: Extract<FleetResponseEnvelope, { readonly status: 'failure' }>['error'],
): FleetResponseEnvelope {
  return {
    kind: 'response', protocolVersion: request.protocolVersion,
    connectionGeneration: request.connectionGeneration, requestId: request.requestId,
    target: request.target, status: 'failure', sideEffect: 'none', error, body: null,
  };
}

export function createPeerOperationDispatcher(
  localHostId: string,
  handlers: PeerOperationHandlers,
): (request: FleetRequestEnvelope) => Promise<FleetResponseEnvelope> {
  return async (request) => {
    if (request.target.hostId !== localHostId) return failure(request, 'HOST_NOT_FOUND');
    if (containsForbiddenField(request.body)) return failure(request, 'FLEET_MALFORMED_FRAME');
    const handler = handlerFor(handlers, request.operation);
    if (handler === undefined) return failure(request, 'FLEET_CAPABILITY_UNAVAILABLE');
    let body: JsonValue;
    try {
      body = await handler(request);
    } catch (error) {
      if (error instanceof FleetReadRpcError || error instanceof FleetMutationRpcError || error instanceof RemoteTerminalPeerError) return failure(request, error.code);
      if (error instanceof RemoteTerminalContractError) return failure(request, 'FLEET_MALFORMED_FRAME');
      // Local service conflicts (stale prompt/approval/generation, invalid local
      // input) are per-request outcomes. They must surface as explicit typed
      // failures; letting them escape would tear down the machine connection
      // and disguise a request-local state conflict as a host outage.
      if (error instanceof AppError && error.statusCode === 409) return failure(request, 'FLEET_STALE_GENERATION');
      if (error instanceof AppError && error.statusCode === 400) return failure(request, 'FLEET_MALFORMED_FRAME');
      throw error;
    }
    const sideEffect = sideEffectFor(request.operation);
    return {
      kind: 'response', protocolVersion: request.protocolVersion,
      connectionGeneration: request.connectionGeneration, requestId: request.requestId,
      target: request.target, status: 'success', sideEffect, body,
    };
  };
}
