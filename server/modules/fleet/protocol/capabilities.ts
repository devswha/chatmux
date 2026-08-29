import type { FleetCapability, FleetEvent, FleetOperation } from '../../../../shared/fleet.js';

import { FleetProtocolError } from './errors.js';

function assertNever(value: never): never {
  throw new FleetProtocolError('PROTOCOL_FRAME_INVALID', `unsupported protocol variant: ${String(value)}`);
}

export function capabilityForOperation(operation: FleetOperation): FleetCapability {
  switch (operation) {
    case 'catalog.snapshot': return 'catalog.read';
    case 'session.read': case 'session.history': case 'session.search': return 'session.read';
    case 'chat.send': case 'chat.abort': return 'chat.control';
    case 'prompt.read': case 'prompt.respond': case 'approval.read': case 'approval.respond': return 'prompt.respond';
    case 'pane.capture': return 'pane.read';
    case 'pane.attach': return 'terminal.attach';
    case 'pane.input': case 'pane.resize': case 'pane.interrupt': case 'pane.escape': return 'terminal.input';
    case 'session.spawn': return 'session.spawn';
    case 'pane.terminate': case 'process.terminate': case 'session.terminate': return 'session.terminate';
    default: return assertNever(operation);
  }
}

export function capabilityForEvent(event: FleetEvent): FleetCapability {
  switch (event) {
    case 'catalog.snapshot': case 'catalog.delta': case 'host.state': return 'catalog.read';
    case 'chat.delta': return 'chat.control';
    case 'prompt.changed': case 'approval.changed': return 'prompt.respond';
    case 'pane.output': return 'pane.read';
    case 'completion.ready': return 'completion.event';
    default: return assertNever(event);
  }
}

export function assertFleetCapability(
  negotiated: readonly FleetCapability[],
  required: FleetCapability,
): void {
  if (!negotiated.includes(required)) {
    throw new FleetProtocolError('PROTOCOL_FRAME_INVALID', 'fleet capability is unavailable');
  }
}
