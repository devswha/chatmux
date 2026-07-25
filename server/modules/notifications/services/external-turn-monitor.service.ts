import { createHash } from 'node:crypto';

import { userDb } from '@/modules/database/index.js';
import { notifyLiveTurnEnded } from '@/modules/notifications/services/notification-orchestrator.service.js';
import {
  getExternalCliSessionsDetailed,
  resolveExternalSessionActivity,
  type ExternalCliSession,
  type ExternalCliSessionsDetailedResult,
  type ExternalSessionActivityResolutionResult,
} from '@/modules/providers/index.js';

import { tmuxPaneIdentityKey } from '../../../../shared/tmux.js';

const DEFAULT_INTERVAL_MS = 5000;
const TRACKED_KINDS = new Set(['claude', 'codex', 'cursor', 'opencode', 'omp']);

type ResolvedActivity = Extract<ExternalSessionActivityResolutionResult, { status: 'resolved' }>;
/** Stable, sensitive-data-free state-machine diagnostic codes. */
export const EXTERNAL_TURN_MONITOR_DIAGNOSTIC_CODES = [
  'baselined',
  'late_id_rebaselined',
  'armed',
  'notified',
  'disarmed_unknown',
  'disarmed_asking',
  'pruned',
  'discovery_unavailable',
  'read_unavailable',
  'provider_id_conflict',
  'generation_reset',
] as const;

const PRODUCTION_DIAGNOSTIC_INTERVAL_MS = 60_000;
const PRODUCTION_EXCEPTIONAL_DIAGNOSTIC_CODES = new Set<ExternalTurnMonitorDiagnosticCode>([
  'discovery_unavailable',
  'read_unavailable',
  'provider_id_conflict',
]);

export type ExternalTurnMonitorDiagnosticCode = (typeof EXTERNAL_TURN_MONITOR_DIAGNOSTIC_CODES)[number];

/** Diagnostic payloads intentionally omit native IDs, pane identities, and transcript data. */
export type ExternalTurnMonitorDiagnostic = Readonly<{
  code: ExternalTurnMonitorDiagnosticCode;
  provider?: string;
  tmuxName?: string;
  count: number;
}>;

export type ExternalTurnMonitorStats = Readonly<Record<ExternalTurnMonitorDiagnosticCode, number>>;

type DiagnosticContext = Pick<ExternalTurnMonitorDiagnostic, 'provider' | 'tmuxName'>;

function diagnosticContext(session: ExternalCliSession): DiagnosticContext {
  return {
    provider: session.kind,
    ...(typeof session.tmuxName === 'string' ? { tmuxName: session.tmuxName } : {}),
  };
}

function createRateLimitedProductionDiagnosticSink(): (event: ExternalTurnMonitorDiagnostic) => void {
  const lastReportedAt = new Map<string, number>();

  return (event) => {
    if (!PRODUCTION_EXCEPTIONAL_DIAGNOSTIC_CODES.has(event.code)) return;

    const rateLimitKey = `${event.code}\u0000${event.provider ?? ''}`;
    const now = Date.now();
    const previous = lastReportedAt.get(rateLimitKey);
    if (previous !== undefined && now - previous < PRODUCTION_DIAGNOSTIC_INTERVAL_MS) return;

    lastReportedAt.set(rateLimitKey, now);
    const provider = event.provider ? ` for ${event.provider}` : '';
    console.warn(`External turn monitor diagnostic: ${event.code}${provider} (count ${event.count}).`);
  };
}

type MonitorDeps = {
  getDetailed: () => Promise<ExternalCliSessionsDetailedResult>;
  resolve: (session: ExternalCliSession) => Promise<ExternalSessionActivityResolutionResult>;
  notify: (args: {
    userId: number;
    provider: string;
    sessionId: string | null;
    tmuxName: string;
    completionKey: string;
  }) => void;
  getUserId: () => number | null;
  diagnostic?: (event: ExternalTurnMonitorDiagnostic) => void;
};

type GenerationState = {
  paneKey: string;
  provider: string;
  tmuxName?: string;
  providerSessionId: string | null;
  armed: boolean;
  ordinal: number;
};

function providerSessionId(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function observedPaneKey(session: ExternalCliSession): string | null {
  if (
    !TRACKED_KINDS.has(session.kind)
    || !session.tmux
    || typeof session.tmux.socketPath !== 'string'
    || !session.tmux.socketPath
    || typeof session.tmux.sessionId !== 'string'
    || !session.tmux.sessionId
    || typeof session.tmux.windowId !== 'string'
    || !session.tmux.windowId
    || typeof session.tmux.paneId !== 'string'
    || !session.tmux.paneId
  ) {
    return null;
  }
  return `${tmuxPaneIdentityKey(session.tmux)}\u0000${session.kind}`;
}

function generationKey(session: ExternalCliSession): string | null {
  const paneKey = observedPaneKey(session);
  if (
    !paneKey
    || typeof session.agentPid !== 'number'
    || !Number.isSafeInteger(session.agentPid)
    || session.agentPid <= 0
    || typeof session.startedAtMs !== 'number'
    || !Number.isFinite(session.startedAtMs)
    || session.startedAtMs <= 0
  ) {
    return null;
  }
  return `${paneKey}\u0000${session.agentPid}\u0000${session.startedAtMs}`;
}

function completionKey(key: string, ordinal: number): string {
  return `${createHash('sha256').update(key).digest('hex')}:${ordinal}`;
}

function asResolvedActivity(value: unknown): ResolvedActivity | null {
  if (!value || typeof value !== 'object') return null;
  const result = value as Partial<ResolvedActivity>;
  if (
    result.status !== 'resolved'
    || !['running', 'waiting_user', 'asking_user', 'unknown'].includes(result.activity ?? '')
  ) {
    return null;
  }
  return result as ResolvedActivity;
}

function notificationSessionId(result: ResolvedActivity): string | null {
  return providerSessionId(result.appSession?.session_id);
}

/**
 * DI-friendly state machine for externally started tmux coding CLIs. Discovery
 * and activity resolution are intentionally separate: an unavailable source
 * must preserve the last known generation rather than invent a completion.
 */
export function createExternalTurnMonitor(deps: MonitorDeps) {
  const generations = new Map<string, GenerationState>();
  let ticking = false;
  const stats = Object.fromEntries(
    EXTERNAL_TURN_MONITOR_DIAGNOSTIC_CODES.map((code) => [code, 0]),
  ) as Record<ExternalTurnMonitorDiagnosticCode, number>;

  const emitDiagnostic = (detail: Omit<ExternalTurnMonitorDiagnostic, 'count'>): void => {
    stats[detail.code] += 1;
    try {
      deps.diagnostic?.({ ...detail, count: stats[detail.code] });
    } catch {
      // Diagnostics are observational and must not alter monitor state.
    }
  };

  const diagnosticStats = (): ExternalTurnMonitorStats => Object.freeze({ ...stats });

  const observeResolved = (
    key: string,
    state: GenerationState,
    session: ExternalCliSession,
    resolved: ResolvedActivity,
    userId: number,
    silent: boolean,
  ): void => {
    const activity = resolved.transcriptEnded ? 'unknown' : resolved.activity;
    if (activity === 'running') {
      if (!state.armed) {
        state.ordinal += 1;
        state.armed = true;
        emitDiagnostic({ code: 'armed', ...diagnosticContext(session) });
      }
      return;
    }
    if (activity === 'waiting_user') {
      if (state.armed && !silent) {
        deps.notify({
          userId,
          provider: session.kind,
          sessionId: notificationSessionId(resolved),
          tmuxName: session.tmuxName,
          completionKey: completionKey(key, state.ordinal),
        });
        emitDiagnostic({ code: 'notified', ...diagnosticContext(session) });
      }
      state.armed = false;
      return;
    }
    // A question is not a turn completion; unknown evidence is never one.
    const wasArmed = state.armed;
    state.armed = false;
    if (wasArmed) {
      emitDiagnostic({
        code: activity === 'asking_user' ? 'disarmed_asking' : 'disarmed_unknown',
        ...diagnosticContext(session),
      });
    }
  };

  const tick = async (): Promise<void> => {
    if (ticking) return;
    ticking = true;
    try {
      const userId = deps.getUserId();
      if (userId == null) return;

      let discovered: ExternalCliSessionsDetailedResult;
      try {
        discovered = await deps.getDetailed();
      } catch (error) {
        emitDiagnostic({ code: 'discovery_unavailable' });
        throw error;
      }
      if (!discovered?.ok || !Array.isArray(discovered.sessions)) {
        emitDiagnostic({ code: 'discovery_unavailable' });
        return;
      }

      const seen = new Set<string>();
      const seenPanes = new Set<string>();
      for (const session of discovered.sessions) {
        const paneKey = observedPaneKey(session);
        if (!paneKey) continue;
        seenPanes.add(paneKey);
        const key = generationKey(session);
        if (!key) continue;
        seen.add(key);

        for (const [existingKey, existingState] of generations) {
          if (existingState.paneKey === paneKey && existingKey !== key) {
            generations.delete(existingKey);
            emitDiagnostic({ code: 'generation_reset', ...diagnosticContext(session) });
          }
        }

        const observedProviderSessionId = providerSessionId(session.providerSessionId);
        let state = generations.get(key);
        let silent = false;
        if (!state) {
          state = {
            paneKey,
            provider: session.kind,
            tmuxName: typeof session.tmuxName === 'string' ? session.tmuxName : undefined,
            providerSessionId: observedProviderSessionId,
            armed: false,
            ordinal: 0,
          };
          generations.set(key, state);
          emitDiagnostic({ code: 'baselined', ...diagnosticContext(session) });
        } else if (observedProviderSessionId) {
          state.tmuxName = typeof session.tmuxName === 'string' ? session.tmuxName : undefined;
          if (!state.providerSessionId) {
            // First late native-id binding may reveal old transcript state.
            // Rebaseline that observation so it cannot replay a completion.
            state.providerSessionId = observedProviderSessionId;
            state.armed = false;
            silent = true;
            emitDiagnostic({ code: 'late_id_rebaselined', ...diagnosticContext(session) });
          } else if (state.providerSessionId !== observedProviderSessionId) {
            // A changed native id for one process generation is ambiguous.
            // Keep the previous state and wait for trustworthy evidence.
            emitDiagnostic({ code: 'provider_id_conflict', ...diagnosticContext(session) });
            continue;
          }
        }

        const resolverSession = state.providerSessionId && !observedProviderSessionId
          ? { ...session, providerSessionId: state.providerSessionId }
          : session;
        let resolved: ResolvedActivity | null;
        try {
          resolved = asResolvedActivity(await deps.resolve(resolverSession));
        } catch {
          emitDiagnostic({ code: 'read_unavailable', ...diagnosticContext(resolverSession) });
          continue;
        }
        if (!resolved) {
          emitDiagnostic({ code: 'read_unavailable', ...diagnosticContext(resolverSession) });
          continue; // unavailable/invalid resolution preserves state
        }
        observeResolved(key, state, resolverSession, resolved, userId, silent);
      }

      // Only a successful discovery pass proves a generation is gone. A pane
      // with temporarily incomplete process metadata preserves its generation.
      for (const [key, state] of generations) {
        if (!seen.has(key) && !seenPanes.has(state.paneKey)) {
          generations.delete(key);
          emitDiagnostic({ code: 'pruned', provider: state.provider, tmuxName: state.tmuxName });
        }
      }
    } finally {
      ticking = false;
    }
  };

  return { tick, generationCount: () => generations.size, stats: diagnosticStats };
}

/**
 * Starts browser-independent Web Push monitoring for tmux CLIs. Self-host is
 * single-user, so completions route to the first configured user.
 */
export function startExternalTurnMonitor(intervalMs = DEFAULT_INTERVAL_MS): (() => void) | null {
  if (process.env.CHATMUX_LIVE_NOTIFY === '0') return null;

  const monitor = createExternalTurnMonitor({
    getDetailed: getExternalCliSessionsDetailed,
    resolve: resolveExternalSessionActivity,
    notify: ({ userId, provider, sessionId, tmuxName, completionKey: key }) =>
      notifyLiveTurnEnded({ userId, provider, sessionId, tmuxName, completionKey: key }),
    getUserId: () => {
      try {
        const user = userDb.getFirstUser();
        return user ? user.id : null;
      } catch {
        return null;
      }
    },
    diagnostic: createRateLimitedProductionDiagnosticSink(),
  });
  const timer = setInterval(() => {
    void monitor.tick().catch(() => {
      // Detection is best-effort; never crash the server loop.
    });
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
