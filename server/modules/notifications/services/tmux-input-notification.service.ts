import {
  completionAppAlias,
  completionNotificationTargetsDb,
  userDb,
} from '@/modules/database/index.js';
import type {
  ExternalCliSession,
  TmuxOutputActivityTarget,
} from '@/modules/providers/index.js';

import { completionTargetResolver } from './completion-target-resolver.service.js';
import { notifyInputRequired } from './notification-orchestrator.service.js';

/** Screen-derived INPUT notifications follow the live monitor kill switch. */
export function tmuxInputNotificationsEnabled(): boolean {
  return process.env.CHATMUX_LIVE_NOTIFY !== '0';
}

/**
 * Routes a tmux screen RUN -> INPUT edge through the same durable target used
 * by the session bell.
 */
export function notifyTmuxInputRequiredIfWatched(
  target: TmuxOutputActivityTarget,
  occurrenceKey: string,
): void {
  if (!tmuxInputNotificationsEnabled()) return;
  let userId: number | null;
  try {
    userId = userDb.getFirstUser()?.id ?? null;
  } catch {
    return;
  }
  if (userId == null) return;

  if (target.kind === 'gjc') {
    if (!target.providerSessionId) return;
    const alias = completionAppAlias({
      provider: 'gjc',
      sessionId: target.providerSessionId,
    });
    const completionTarget = completionNotificationTargetsDb.resolveAlias(alias);
    if (!completionTarget || !completionNotificationTargetsDb.getWatch(userId, completionTarget.id)) return;
    notifyInputRequired({
      userId,
      provider: 'gjc',
      sessionId: target.providerSessionId,
      sessionName: target.tmuxName,
      occurrenceKey,
    });
    return;
  }

  const session: ExternalCliSession = {
    tmuxName: target.tmuxName,
    tmux: target.tmux,
    kind: target.kind,
    agentPid: target.process.pid,
    startedAtMs: target.process.startedAtMs,
    ...(target.providerSessionId ? { providerSessionId: target.providerSessionId } : {}),
  };
  let resolution;
  try {
    [resolution] = completionTargetResolver.resolveDetailedScan({ ok: true, sessions: [session] }, userId);
  } catch {
    return;
  }
  if (!resolution?.target.watched) return;
  notifyInputRequired({
    userId,
    provider: target.kind,
    sessionId: resolution.appSessionId ?? resolution.target.alias,
    sessionName: target.tmuxName,
    occurrenceKey,
  });
}
