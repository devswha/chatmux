import {
  getLiveGjcSessions,
  type LiveGjcSession,
} from '@/modules/providers/services/live-sessions.service.js';
import { AppError } from '@/shared/utils.js';

import type {
  TmuxPaneIdentity,
  TmuxProcessGeneration,
} from '../../../../shared/tmux.js';

import {
  assertTmuxPaneIdentity,
  readTmuxPaneIdentity,
  readTmuxProcessGeneration,
  sameTmuxPaneIdentity,
} from './tmux-pane-actions.service.js';
import {
  assertFreshExternalTmuxTarget,
  createVerifiedTmuxActionTarget,
  type VerifiedTmuxActionTarget,
} from './tmux-fresh-verifier.service.js';

type LiveSessionLoader = () => Promise<LiveGjcSession[]>;
type PaneIdentityAssert = (tmux: TmuxPaneIdentity) => Promise<void>;

/**
 * Server-side lineage gate for injective and destructive pane actions.
 * Both immutable tmux coordinates and the agent PID/start-time generation must
 * still match a fresh discovery snapshot.
 */
export async function assertLineageTmuxTarget(
  identity: TmuxPaneIdentity,
  process: TmuxProcessGeneration,
  loadLiveSessions: LiveSessionLoader = getLiveGjcSessions,
  assertPaneIdentity: PaneIdentityAssert = assertTmuxPaneIdentity,
): Promise<VerifiedTmuxActionTarget> {
  const live = await loadLiveSessions();
  const matches = live.filter(
    (session) => (
      session.tmux !== null
      && sameTmuxPaneIdentity(session.tmux, identity)
      && session.claim === 'lineage'
    ),
  );
  if (matches.length === 0) {
    throw new AppError(
      'tmux pane action was refused because the agent lineage is no longer present.',
      { code: 'TMUX_ACTION_NOT_LINEAGE', statusCode: 403 },
    );
  }
  const exact = matches.find((session) => (
    session.process?.pid === process.pid
    && session.process.startedAtMs === process.startedAtMs
    // Discovery excluded this pane (cross-user / cross-HOME / socket owner
    // mismatch); control paths must honor the exclusion, not just the UI.
    && !session.connectionIssue
  ));
  if (!exact) {
    throw new AppError(
      'The tmux pane now belongs to a different agent process. Reopen it from the session list.',
      { code: 'TMUX_PROCESS_GENERATION_MISMATCH', statusCode: 409 },
    );
  }
  // The lineage snapshot alone cannot prove the pane still holds these exact
  // coordinates, so re-read them from tmux before minting a verified target.
  await assertPaneIdentity(exact.tmux!);
  return createVerifiedTmuxActionTarget(
    exact.tmux!,
    process,
    'gjc',
    exact.tmuxName,
    exact.id,
    exact.binding ?? null,
  );
}

/**
 * Authorizes a local-agent pane for terminal attach across both discovery
 * lanes. External CLIs (claude/codex/cursor/opencode/omp) are verified by the
 * fresh external scan; gjc panes live in the live lane and are verified by
 * the same lineage gate that authorizes live sends. Both lanes require the
 * exact tmux 4-tuple plus a matching process generation, so this widens which
 * roster is consulted, never how strictly a target must match.
 */
export async function assertFreshLocalAgentTmuxTarget(
  tmuxValue: unknown,
  processValue: unknown,
  deps: {
    assertExternal?: typeof assertFreshExternalTmuxTarget;
    loadLiveSessions?: LiveSessionLoader;
    assertPaneIdentity?: PaneIdentityAssert;
  } = {},
): Promise<VerifiedTmuxActionTarget> {
  try {
    return await (deps.assertExternal ?? assertFreshExternalTmuxTarget)(tmuxValue, processValue);
  } catch (error) {
    const isGenerationMismatch =
      error instanceof AppError && error.code === 'TMUX_PROCESS_GENERATION_MISMATCH';
    if (!isGenerationMismatch) {
      throw error;
    }
    // Not in the external roster: the pane may be a live gjc target. A pane
    // absent from both rosters still fails closed inside the lineage gate.
    const identity = readTmuxPaneIdentity(tmuxValue);
    const generation = readTmuxProcessGeneration(processValue);
    return assertLineageTmuxTarget(
      identity,
      generation,
      deps.loadLiveSessions,
      deps.assertPaneIdentity,
    );
  }
}
