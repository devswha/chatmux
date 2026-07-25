import {
  getLiveGjcSessions,
  type LiveGjcSession,
} from '@/modules/providers/services/live-sessions.service.js';
import { AppError } from '@/shared/utils.js';

import type {
  TmuxPaneIdentity,
  TmuxProcessGeneration,
} from '../../../../shared/tmux.js';

import { assertTmuxPaneIdentity, sameTmuxPaneIdentity } from './tmux-pane-actions.service.js';
import { createVerifiedTmuxActionTarget, type VerifiedTmuxActionTarget } from './tmux-fresh-verifier.service.js';

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
  ));
  if (!exact) {
    throw new AppError(
      'The tmux pane now belongs to a different agent process. Reopen it from the session list.',
      { code: 'TMUX_PROCESS_GENERATION_MISMATCH', statusCode: 409 },
    );
  }
  // The lineage snapshot alone cannot prove the pane still holds these exact
  // coordinates, so re-read them from tmux before minting a verified target.
  await assertPaneIdentity(identity);
  return createVerifiedTmuxActionTarget(
    identity,
    process,
    'gjc',
    exact.tmuxName,
  );
}
