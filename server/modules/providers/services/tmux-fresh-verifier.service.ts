import {
  getExternalCliSessionsFresh,
  type ExternalCliKind,
  type ExternalCliSession,
  type ExternalSessionBinding,
} from '@/modules/providers/services/external-cli-sessions.service.js';
import { AppError } from '@/shared/utils.js';

import type { TmuxPaneIdentity, TmuxProcessGeneration } from '../../../../shared/tmux.js';

import {
  assertTmuxPaneIdentity,
  readTmuxPaneIdentity,
  readTmuxProcessGeneration,
  sameTmuxPaneIdentity,
} from './tmux-pane-actions.service.js';

const verifiedTmuxActionTarget = Symbol('VerifiedTmuxActionTarget');

export type VerifiedTmuxActionTarget = Readonly<{
  tmux: Readonly<TmuxPaneIdentity>;
  process: Readonly<TmuxProcessGeneration>;
  kind: ExternalCliKind | 'gjc';
  tmuxName: string | null;
  providerSessionId: string | null;
  /** How `providerSessionId` was tied to this process; null when unknown or not applicable (gjc). */
  binding: ExternalSessionBinding | null;
  readonly [verifiedTmuxActionTarget]: true;
}>;

type FreshScan = () => Promise<ExternalCliSession[]>;
type PaneIdentityAssert = (tmux: TmuxPaneIdentity) => Promise<void>;

export type FreshExternalTmuxTargetDeps = {
  scan?: FreshScan;
  assertPaneIdentity?: PaneIdentityAssert;
};

/** Constructs the opaque handoff used only by target verifiers. */
export function createVerifiedTmuxActionTarget(
  tmux: TmuxPaneIdentity,
  process: TmuxProcessGeneration,
  kind: ExternalCliKind | 'gjc',
  tmuxName: string | null,
  providerSessionId: string | null = null,
  binding: ExternalSessionBinding | null = null,
): VerifiedTmuxActionTarget {
  return Object.freeze({
    tmux: Object.freeze({ ...tmux }),
    process: Object.freeze({ ...process }),
    kind,
    tmuxName,
    providerSessionId,
    binding: providerSessionId === null ? null : binding,
    [verifiedTmuxActionTarget]: true as const,
  });
}

/**
 * Authorizes an existing external pane from exactly one uncached discovery scan.
 * Discovery caches are display-only and must never be used for control authority.
 */
export async function assertFreshExternalTmuxTarget(
  tmuxValue: unknown,
  processValue: unknown,
  deps: FreshExternalTmuxTargetDeps = {},
): Promise<VerifiedTmuxActionTarget> {
  const tmux = readTmuxPaneIdentity(tmuxValue);
  const process = readTmuxProcessGeneration(processValue);
  const sessions = await (deps.scan ?? getExternalCliSessionsFresh)();
  const target = sessions.find((session) => (
    session.kind !== 'ssh'
    && session.kind !== 'shell'
    && sameTmuxPaneIdentity(session.tmux, tmux)
    && session.agentPid === process.pid
    && session.startedAtMs === process.startedAtMs
    // Discovery excluded this pane (cross-user / cross-HOME / socket owner
    // mismatch); control paths must honor the exclusion, not just the UI.
    && !session.connectionIssue
  ));
  if (!target) {
    throw new AppError('The selected tmux pane now belongs to a different agent process.', {
      code: 'TMUX_PROCESS_GENERATION_MISMATCH',
      statusCode: 409,
    });
  }

  await (deps.assertPaneIdentity ?? assertTmuxPaneIdentity)(tmux);
  return createVerifiedTmuxActionTarget(
    tmux,
    process,
    target.kind,
    target.tmuxName,
    target.providerSessionId ?? null,
    target.binding ?? null,
  );
}
