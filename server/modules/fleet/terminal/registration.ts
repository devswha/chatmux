import type { FleetRequestEnvelope, JsonValue } from '../../../../shared/fleet.js';
import type { PeerOperationHandler, PeerOperationHandlers } from '../peer/operation-dispatcher.js';

import type { RemoteTerminalHandlers } from './peer.js';

function isRecord(value: JsonValue): value is Readonly<Record<string, JsonValue>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function isTerminalFrame(request: FleetRequestEnvelope): boolean {
  return isRecord(request.body) && Object.keys(request.body).includes('lease');
}
function required(handler: PeerOperationHandler | undefined): PeerOperationHandler {
  if (handler === undefined) throw new TypeError('fleet mutation handler is unavailable');
  return handler;
}

export function registerRemoteTerminalHandlers(
  base: PeerOperationHandlers,
  terminal: RemoteTerminalHandlers,
): PeerOperationHandlers {
  const input = required(base['pane.input']);
  const escape = required(base['pane.escape']);
  return {
    ...base,
    'pane.attach': terminal['pane.attach'],
    'pane.resize': terminal['pane.resize'],
    'pane.input': (request) => isTerminalFrame(request) ? terminal['pane.input'](request) : input(request),
    'pane.escape': (request) => isTerminalFrame(request) ? terminal['pane.escape'](request) : escape(request),
  };
}
