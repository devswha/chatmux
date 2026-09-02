import { AppError } from '@/shared/utils.js';

import type { ExternalSessionBinding } from './external-cli-sessions.service.js';

export const SESSION_BINDING_INFERRED_CODE = 'TMUX_SESSION_BINDING_INFERRED' as const;

/**
 * An inferred binding (cwd plus time window) can name a different TUI in the
 * same folder. Anything that turns a transcript or session id into keystrokes
 * for a pane must refuse it; the user answers in the terminal (attach), the
 * fallback the M5B approval contract prescribes.
 */
export function isInferredSessionBinding(binding: ExternalSessionBinding | null | undefined): boolean {
  return binding === 'inferred';
}

export function assertProvenSessionBinding(target: Readonly<{ binding: ExternalSessionBinding | null }>): void {
  if (!isInferredSessionBinding(target.binding)) return;
  throw new AppError(
    'This pane is linked to its transcript by folder and timing only. Open the terminal to answer.',
    { code: SESSION_BINDING_INFERRED_CODE, statusCode: 409 },
  );
}
