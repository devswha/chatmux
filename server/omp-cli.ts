import {
  buildPiCliArgs,
  createPiCliRuntime,
  normalizePiCliEvent,
  type PiCliDescriptor,
  type PiCliRunOptions,
  type PiCliWriter,
} from './pi-cli.js';
import type { NormalizedMessage } from './shared/types.js';

const OMP: PiCliDescriptor = {
  provider: 'omp',
  binary: 'omp',
  label: 'Oh My Pi',
};

const runtime = createPiCliRuntime(OMP);

export function buildOmpArgs(command: string, options: PiCliRunOptions): string[] {
  return buildPiCliArgs(command, options, OMP.provider);
}

export function normalizeOmpEvent(
  eventValue: unknown,
  sessionId: string | null,
): { providerSessionId?: string; messages: NormalizedMessage[] } {
  return normalizePiCliEvent(eventValue, sessionId, OMP);
}

export function spawnOmp(
  command: string,
  options: PiCliRunOptions = {},
  writer: PiCliWriter,
): Promise<void> {
  return runtime.spawn(command, options, writer);
}

export function abortOmpSession(sessionId: string): boolean {
  return runtime.abort(sessionId);
}
