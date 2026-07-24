import {
  getLiveGjcSessions,
  type LiveGjcSession,
} from '@/modules/providers/services/live-sessions.service.js';
import { AppError } from '@/shared/utils.js';

import type {
  TmuxPaneIdentity,
  TmuxProcessGeneration,
} from '../../../../shared/tmux.js';

import { sameTmuxPaneIdentity } from './tmux-pane-actions.service.js';

type LiveSessionLoader = () => Promise<LiveGjcSession[]>;

/**
 * Server-side lineage gate for injective and destructive pane actions.
 * Both immutable tmux coordinates and the agent PID/start-time generation must
 * still match a fresh discovery snapshot.
 */
export async function assertLineageTmuxTarget(
  identity: TmuxPaneIdentity,
  process: TmuxProcessGeneration,
  loadLiveSessions: LiveSessionLoader = getLiveGjcSessions,
): Promise<LiveGjcSession> {
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
  return exact;
}
