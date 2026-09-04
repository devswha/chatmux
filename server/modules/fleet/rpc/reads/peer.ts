import type {
  FleetPaneReference,
  FleetRequestEnvelope,
  JsonValue,
} from '../../../../../shared/fleet.js';
import type { PeerOperationHandlers } from '../../peer/operation-dispatcher.js';

import { FleetReadContractError, parseFleetReadRequest, type FleetReadRequest } from './contracts.js';
import { FleetReadRpcError } from './errors.js';

export type FleetReadServices = Readonly<{
  readonly toolResult?: (localId: string, options: Readonly<{ toolId: string; offset: number; revision: string | null }>, signal: AbortSignal) => Promise<JsonValue>;
  readonly sessionMetadata: (localId: string, signal: AbortSignal) => Promise<JsonValue | null>;
  readonly history: (localId: string, options: Readonly<{ readonly limit: number | null; readonly offset: number; readonly includeImages: boolean }>, signal: AbortSignal) => Promise<JsonValue>;
  readonly search: (projectLocalId: string, options: Readonly<{ readonly query: string; readonly limit: number; readonly signal: AbortSignal }>) => Promise<JsonValue>;
  readonly prompt: (localId: string, signal: AbortSignal) => Promise<JsonValue>;
  readonly approval: (localId: string, signal: AbortSignal) => Promise<JsonValue>;
  readonly capturePane: (target: FleetPaneReference, signal: AbortSignal) => Promise<JsonValue>;
  readonly providerInventory: (localId: string, signal: AbortSignal) => Promise<JsonValue | null>;
  readonly chatSubscription: (localId: string, lastSeq: number, signal: AbortSignal) => Promise<JsonValue | null>;
  readonly pathSuggestions: (projectLocalId: string, prefix: string, signal: AbortSignal) => Promise<JsonValue | null>;
}>;

const REDACTED_FIELDS = new Set(['sourcePath', 'jsonlPath', 'transcriptPath', 'socketPath', 'home', 'diagnostic', 'details']);

function redact(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(redact);
  if (value === null || typeof value !== 'object') return value;
  const output: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!REDACTED_FIELDS.has(key)) output[key] = redact(item);
  }
  return output;
}

function deadlineAt(request: FleetReadRequest): number { return request.body.deadlineAtMs; }

async function bounded<T>(deadlineAtMs: number, now: () => number, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const remaining = deadlineAtMs - now();
  if (remaining <= 0) throw new FleetReadRpcError('FLEET_DEADLINE_EXCEEDED', 'fleet read deadline exceeded');
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new FleetReadRpcError('FLEET_DEADLINE_EXCEEDED', 'fleet read deadline exceeded')); }, remaining);
    timer.unref();
  });
  try {
    return await Promise.race([operation(controller.signal), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function execute(request: FleetReadRequest, services: FleetReadServices, signal: AbortSignal): Promise<JsonValue> {
  switch (request.operation) {
    case 'session.read': {
      if (request.body.read === 'tool_result') {
        if (!services.toolResult) throw new FleetReadRpcError('FLEET_CAPABILITY_UNAVAILABLE', 'tool output reads are unavailable');
        return services.toolResult(request.target.localId, request.body, signal);
      }
      const value = request.body.read === 'metadata'
        ? await services.sessionMetadata(request.target.localId, signal)
        : request.body.read === 'provider_inventory'
          ? await services.providerInventory(request.target.localId, signal)
          : await services.chatSubscription(request.target.localId, request.body.lastSeq, signal);
      if (value === null) throw new FleetReadRpcError('HOST_NOT_FOUND', 'local session was not found');
      return request.body.read === 'provider_inventory' ? redact(value) : value;
    }
    case 'session.history': return services.history(request.target.localId, request.body, signal);
    case 'session.search': {
      const value = request.body.read === 'transcript_search'
        ? await services.search(request.target.localId, { query: request.body.query, limit: request.body.limit, signal })
        : await services.pathSuggestions(request.target.localId, request.body.prefix, signal);
      if (value === null) throw new FleetReadRpcError('HOST_NOT_FOUND', 'local project was not found');
      return request.body.read === 'path_suggestions' ? redact(value) : value;
    }
    case 'prompt.read': return services.prompt(request.target.localId, signal);
    case 'approval.read': return services.approval(request.target.localId, signal);
    case 'pane.capture': return services.capturePane(request.target, signal);
  }
}

export function createFleetReadHandlers(
  localHostId: string,
  services: FleetReadServices,
  now: () => number = Date.now,
): PeerOperationHandlers {
  const handle = async (request: FleetRequestEnvelope): Promise<JsonValue> => {
    if (request.target.hostId !== localHostId) throw new FleetReadRpcError('HOST_NOT_FOUND', 'read target belongs to another host');
    try {
      const parsed = parseFleetReadRequest(request);
      return await bounded(deadlineAt(parsed), now, (signal) => execute(parsed, services, signal));
    } catch (error) {
      if (error instanceof FleetReadContractError) throw new FleetReadRpcError('FLEET_MALFORMED_FRAME', error.message);
      throw error;
    }
  };
  return {
    'session.read': handle, 'session.history': handle, 'session.search': handle,
    'prompt.read': handle, 'approval.read': handle, 'pane.capture': handle,
  };
}
