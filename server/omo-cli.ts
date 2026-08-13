import {
  buildPiCliArgs,
  createPiCliRuntime,
  normalizePiCliEvent,
  type PiCliDescriptor,
  type PiCliRunOptions,
  type PiCliWriter,
} from './pi-cli.js';
import type { NormalizedMessage } from './shared/types.js';

const OMO: PiCliDescriptor = {
  provider: 'omo',
  binary: 'omo',
  label: 'omo',
};

const runtime = createPiCliRuntime(OMO);

export function buildOmoArgs(command: string, options: PiCliRunOptions): string[] {
  return buildPiCliArgs(command, options);
}

export function normalizeOmoEvent(
  eventValue: unknown,
  sessionId: string | null,
): { providerSessionId?: string; messages: NormalizedMessage[] } {
  return normalizePiCliEvent(eventValue, sessionId, OMO);
}

export function spawnOmo(
  command: string,
  options: PiCliRunOptions = {},
  writer: PiCliWriter,
): Promise<void> {
  return runtime.spawn(command, options, writer);
}

export function abortOmoSession(sessionId: string): boolean {
  return runtime.abort(sessionId);
}
