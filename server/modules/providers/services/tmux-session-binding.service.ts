import { AppError } from '@/shared/utils.js';

import type { ExternalSessionBinding } from './external-cli-sessions.service.js';

export const SESSION_BINDING_INFERRED_CODE = 'TMUX_SESSION_BINDING_INFERRED' as const;

/**
 * An inferred binding (cwd plus time window) can name a different TUI in the
 * same folder. Anything that turns a transcript or session id into keystrokes
 * for a pane must refuse it; the user answers in the terminal (attach), the
 * fallback the M5B approval contract prescribes.
 */
/** Classification only; authorization must require isProvenSessionBinding. */
export function isInferredSessionBinding(binding: ExternalSessionBinding | null | undefined): boolean {
  return binding === 'inferred';
}

/** Only positive process-bound evidence can turn a transcript/session id into input. */
export function isProvenSessionBinding(binding: unknown): binding is 'tagged' | 'observed' {
  return binding === 'tagged' || binding === 'observed';
}

export function assertProvenSessionBinding(target: Readonly<{ binding?: unknown }>): void {
  if (isProvenSessionBinding(target.binding)) return;
  throw new AppError(
    'This pane has no proven process-bound link to its transcript. Open the terminal to answer.',
    { code: SESSION_BINDING_INFERRED_CODE, statusCode: 409 },
  );
}
