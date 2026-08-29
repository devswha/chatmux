import { createHash } from 'node:crypto';

import {
  completionExternalGenerationIdentityFromSession,
  completionExternalGenerationIdentityKey,
  completionNotificationOutboxDb,
  completionNotificationTargetsDb,
  userDb,
} from '@/modules/database/index.js';
import { fleetCompletionPeerGateway } from '@/modules/fleet/index.js';
import {
  getExternalCliSessionsDetailed,
  onTranscriptChanged,
  resolveExternalSessionActivity,
  type ExternalCliSession,
  type ExternalCliSessionsDetailedResult,
} from '@/modules/providers/index.js';

import { startEventDrivenMonitorLoop, TURN_MONITOR_FALLBACK_MS } from './event-driven-monitor-loop.service.js';
import { createExternalTurnMonitor } from './external-turn-monitor.service.js';

const EVENT_DRIVEN_PROVIDERS = new Set(['claude', 'codex', 'omp', 'omo', 'opencode']);

type TerminalInput = Parameters<typeof completionNotificationOutboxDb.recordTerminalDecision>[0];
type TerminalResult = ReturnType<typeof completionNotificationOutboxDb.recordTerminalDecision>;

export type ExternalCompletionSessionRoster = ReadonlyMap<string, ExternalCliSession>;

function completionAppLocalId(input: TerminalInput): string | null {
  const match = input.payload.navigation.href.match(/^\/session\/([^/]+)$/);
  if (match === null) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

function normalizedLabel(value: string): string | null {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) return null;
  return normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized;
}

function roster(sessions: readonly ExternalCliSession[]): ExternalCompletionSessionRoster {
  const result = new Map<string, ExternalCliSession>();
  for (const session of sessions) {
    const identity = completionExternalGenerationIdentityFromSession(session);
    if (identity === null) continue;
    result.set(completionExternalGenerationIdentityKey(identity), session);
  }
  return result;
}

export function publishFleetTerminalCompletion(
  input: TerminalInput,
  result: TerminalResult,
  current: ExternalCompletionSessionRoster,
): void {
  if (result.status === 'baselined' || (result.status === 'replay' && result.decisionIds.length === 0)) return;
  const identityKey = completionNotificationTargetsDb.listGenerationTargets()
    .find(({ id }) => id === input.generationTargetId)?.identityKey;
  const session = identityKey === undefined ? undefined : current.get(identityKey);
  if (session?.agentPid === undefined || session.startedAtMs === undefined) return;
  fleetCompletionPeerGateway.pane({
    provider: session.kind,
    lane: 'external',
    appLocalId: completionAppLocalId(input),
    occurrenceKey: createHash('sha256')
      .update(identityKey ?? '')
      .update('\0')
      .update(input.evidenceCursor)
      .digest('hex'),
    sessionLabel: normalizedLabel(session.tmuxName),
    tmux: {
      sessionId: session.tmux.sessionId,
      windowId: session.tmux.windowId,
      paneId: session.tmux.paneId,
    },
    process: { pid: session.agentPid, startedAtMs: session.startedAtMs },
  });
}

export function startExternalTurnMonitor(
  intervalMs = TURN_MONITOR_FALLBACK_MS,
  getDetailed: () => Promise<ExternalCliSessionsDetailedResult> = getExternalCliSessionsDetailed,
): (() => void) | null {
  if (process.env.CHATMUX_LIVE_NOTIFY === '0') return null;
  let current: ExternalCompletionSessionRoster = new Map();
  const monitoredDetailed = async (): Promise<ExternalCliSessionsDetailedResult> => {
    const detailed = await getDetailed();
    if (detailed.ok) current = roster(detailed.sessions);
    return detailed;
  };
  const monitor = createExternalTurnMonitor({
    getDetailed: monitoredDetailed,
    resolve: resolveExternalSessionActivity,
    getUserId: () => {
      try {
        return userDb.getFirstUser()?.id ?? null;
      } catch {
        return null;
      }
    },
    createTerminalDecision: (input) => {
      const result = completionNotificationOutboxDb.recordTerminalDecision(input);
      publishFleetTerminalCompletion(input, result, current);
      return result;
    },
  });
  return startEventDrivenMonitorLoop({
    tick: monitor.tick,
    subscribe: onTranscriptChanged,
    accepts: (change) => EVENT_DRIVEN_PROVIDERS.has(change.provider),
    fallbackMs: intervalMs,
  });
}
