
import {
  completionExternalGenerationIdentityFromSession,
  completionExternalGenerationIdentityKey,
  completionExternalGenerationPaneEvidenceKey,
  completionNotificationOutboxDb,
  completionNotificationTargetsDb,
  userDb,
} from '@/modules/database/index.js';
import {
  getExternalCliSessionsDetailed,
  onTranscriptChanged,
  resolveExternalSessionActivity,
  type ExternalCliSession,
  type ExternalCliSessionsDetailedResult,
  type ExternalSessionActivityResolutionResult,
} from '@/modules/providers/index.js';

import { wakeCompletionOutboxDispatcher } from './completion-outbox-dispatcher.service.js';
import {
  startEventDrivenMonitorLoop,
  TURN_MONITOR_FALLBACK_MS,
} from './event-driven-monitor-loop.service.js';
import {
  completionTargetResolver,
  isSupportedExternalCompletionProvider,
  type CompletionTargetResolution,
} from './completion-target-resolver.service.js';

type TerminalCompletionDecision = Parameters<typeof completionNotificationOutboxDb.recordTerminalDecision>[0];
type TerminalCompletionDecisionResult = ReturnType<typeof completionNotificationOutboxDb.recordTerminalDecision>;
type GenerationObservation = Parameters<typeof completionNotificationTargetsDb.observeGeneration>[2];

const DEFAULT_INTERVAL_MS = TURN_MONITOR_FALLBACK_MS;
const EVENT_DRIVEN_EXTERNAL_PROVIDERS = new Set(['claude', 'codex', 'omp', 'opencode']);

type ResolvedActivity = Extract<ExternalSessionActivityResolutionResult, { status: 'resolved' }>;
type MonitorResolvedActivity = ResolvedActivity & {
  terminalOutcome: NonNullable<ResolvedActivity['terminalOutcome']>;
  evidenceCursor: NonNullable<ResolvedActivity['evidenceCursor']>;
  evidenceDigest: NonNullable<ResolvedActivity['evidenceDigest']>;
};


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
  'decision_unavailable',
  'provider_id_conflict',
  'generation_reset',
  'user_lookup_unavailable',
  'unexpected_tick_failure',
] as const;

const PRODUCTION_DIAGNOSTIC_INTERVAL_MS = 60_000;
const PRODUCTION_EXCEPTIONAL_DIAGNOSTIC_CODES = new Set<ExternalTurnMonitorDiagnosticCode>([
  'discovery_unavailable',
  'read_unavailable',
  'decision_unavailable',
  'provider_id_conflict',
  'user_lookup_unavailable',
  'unexpected_tick_failure',
]);

export type ExternalTurnMonitorDiagnosticCode = (typeof EXTERNAL_TURN_MONITOR_DIAGNOSTIC_CODES)[number];
export type ExternalTurnMonitorDiagnostic = Readonly<{
  code: ExternalTurnMonitorDiagnosticCode;
  provider?: string;
  tmuxName?: string;
  count: number;
}>;
export type ExternalTurnMonitorStats = Readonly<Record<ExternalTurnMonitorDiagnosticCode, number>>;

type DiagnosticContext = Pick<ExternalTurnMonitorDiagnostic, 'provider' | 'tmuxName'>;
type ResolveTargets = (detailed: ExternalCliSessionsDetailedResult, userId: number) => CompletionTargetResolution[];
type ObserveGeneration = (
  generationTargetId: number,
  evidenceCursor: string,
  observation: GenerationObservation,
) => ReturnType<typeof completionNotificationTargetsDb.observeGeneration>;
type CreateTerminalDecision = (input: TerminalCompletionDecision) => TerminalCompletionDecisionResult;
type TouchObservedGenerations = Parameters<typeof completionNotificationTargetsDb.touchObservedGenerations>[0] extends infer Observations
  ? (observations: Observations, lastSeenAt: number) => void
  : never;
type ListStaleGenerationCandidates = (cutoff: number) => Array<{
  generationTargetId: number;
  paneEvidenceKey: string;
  lastSeenAt: number;
}>;
type PruneStaleGenerationCandidates = (cutoff: number, approvedGenerationTargetIds: readonly number[]) => number;
type GenerationCount = () => number;
type ListGenerationTargets = () => Array<{ id: number; identityKey: string }>;

type MonitorDeps = {
  getDetailed: () => Promise<ExternalCliSessionsDetailedResult>;
  resolve: (session: ExternalCliSession) => Promise<ExternalSessionActivityResolutionResult>;
  getUserId: () => number | null;
    resolveTargets?: ResolveTargets;
    observeGeneration?: ObserveGeneration;
    createTerminalDecision?: CreateTerminalDecision;
    listGenerationTargets?: ListGenerationTargets;
    touchObservedGenerations?: TouchObservedGenerations;
    listStaleGenerationCandidates?: ListStaleGenerationCandidates;
    pruneStaleGenerationCandidates?: PruneStaleGenerationCandidates;
    generationCount?: GenerationCount;
  wake?: () => void;
  diagnostic?: (event: ExternalTurnMonitorDiagnostic) => void;
  now?: () => number;
  /** @deprecated Durable outbox decisions replace callback notifications. */
  notify?: (args: {
    userId: number;
    provider: string;
    sessionId: string | null;
    tmuxName: string;
    completionKey: string;
  }) => void;
};

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
    const key = `${event.code}\u0000${event.provider ?? ''}`;
    const previous = lastReportedAt.get(key);
    const now = Date.now();
    if (previous !== undefined && now - previous < PRODUCTION_DIAGNOSTIC_INTERVAL_MS) return;
    lastReportedAt.set(key, now);
    console.warn(`External turn monitor diagnostic: ${event.code}${event.provider ? ` for ${event.provider}` : ''} (count ${event.count}).`);
  };
}

function asResolvedActivity(value: unknown): MonitorResolvedActivity | null {
  if (!value || typeof value !== 'object') return null;
  const result = value as Partial<ResolvedActivity>;
  if (
    result.status !== 'resolved'
    || !['running', 'waiting_user', 'asking_user', 'unknown'].includes(result.activity ?? '')
    || !['reply_ready', 'failed', 'none', 'unknown'].includes(result.terminalOutcome ?? '')
    || typeof result.evidenceCursor !== 'string'
    || !result.evidenceCursor
    || typeof result.evidenceDigest !== 'string'
    || !result.evidenceDigest
  ) return null;
  return result as MonitorResolvedActivity;
}

function completionPayload(session: ExternalCliSession, target: CompletionTargetResolution['target']): TerminalCompletionDecision['payload'] {
  const title = typeof session.tmuxName === 'string' && session.tmuxName.trim()
    ? session.tmuxName.trim()
    : 'ChatMux';
  const label = session.kind === 'omp' ? 'Oh My Pi' : ({
    claude: 'Claude',
    codex: 'Codex',
    opencode: 'OpenCode',
  } as Record<string, string>)[session.kind] ?? 'Assistant';
  return {
    title,
    body: `${label}: Reply ready`,
    navigation: {
      href: `/session/${encodeURIComponent(target.alias)}`,
      title,
    },
  };
}

/**
 * A durable monitor: every arm, baseline, terminal decision, and cursor update
 * is transactionally stored against the exact external process generation.
 */
export function createExternalTurnMonitor(deps: MonitorDeps) {
  let ticking = false;
  const stats = Object.fromEntries(
    EXTERNAL_TURN_MONITOR_DIAGNOSTIC_CODES.map((code) => [code, 0]),
  ) as Record<ExternalTurnMonitorDiagnosticCode, number>;
  const resolveTargets = deps.resolveTargets ?? completionTargetResolver.resolveDetailedScan;
  const observeGeneration = deps.observeGeneration ?? completionNotificationTargetsDb.observeGeneration.bind(completionNotificationTargetsDb);
  const createTerminalDecision = deps.createTerminalDecision ?? completionNotificationOutboxDb.recordTerminalDecision.bind(completionNotificationOutboxDb);
  const wake = deps.wake ?? wakeCompletionOutboxDispatcher;
  const touchObservedGenerations = deps.touchObservedGenerations
    ?? completionNotificationTargetsDb.touchObservedGenerations.bind(completionNotificationTargetsDb);
  const listGenerationTargets = deps.listGenerationTargets
    ?? completionNotificationTargetsDb.listGenerationTargets.bind(completionNotificationTargetsDb);
  const listStaleGenerationCandidates = deps.listStaleGenerationCandidates
    ?? completionNotificationTargetsDb.listStaleGenerationCandidates.bind(completionNotificationTargetsDb);
  const pruneStaleGenerationCandidates = deps.pruneStaleGenerationCandidates
    ?? completionNotificationTargetsDb.pruneStaleGenerationCandidates.bind(completionNotificationTargetsDb);
  const generationCount = deps.generationCount
    ?? completionNotificationTargetsDb.generationCount.bind(completionNotificationTargetsDb);
  const readBackoff = new Map<string, {
    failures: number;
    nextReadAt: number;
    providerBinding: string | null;
  }>();
  const now = deps.now ?? Date.now;

  const emitDiagnostic = (detail: Omit<ExternalTurnMonitorDiagnostic, 'count'>): void => {
    stats[detail.code] += 1;
    try {
      deps.diagnostic?.({ ...detail, count: stats[detail.code] });
    } catch {
      // Diagnostics never affect durable state.
    }
  };

  const tick = async (): Promise<void> => {
    if (ticking) return;
    ticking = true;
    try {
      let userId: number | null;
      try {
        userId = deps.getUserId();
      } catch {
        emitDiagnostic({ code: 'user_lookup_unavailable' });
        return;
      }
      if (userId == null) {
        emitDiagnostic({ code: 'user_lookup_unavailable' });
        return;
      }

      let detailed: ExternalCliSessionsDetailedResult;
      try {
        detailed = await deps.getDetailed();
      } catch {
        emitDiagnostic({ code: 'discovery_unavailable' });
        return;
      }
      if (!detailed?.ok || !Array.isArray(detailed.sessions)) {
        emitDiagnostic({ code: 'discovery_unavailable' });
        return;
      }

      // One detailed discovery result feeds both durable target resolution and
      // activity reads. An incomplete scan cannot authoritatively prove absence.
      const completeScan = detailed.sessions.every((session) => (
        !isSupportedExternalCompletionProvider(session)
        || completionExternalGenerationIdentityFromSession(session) !== null
      ));
      let resolutions: CompletionTargetResolution[];
      try {
        resolutions = resolveTargets(detailed, userId);
      } catch {
        emitDiagnostic({ code: 'decision_unavailable' });
        return;
      }
      const sessionsByIdentity = new Map<string, ExternalCliSession | null>();
      const duplicateSessionIdentities = new Set<string>();
      for (const session of detailed.sessions) {
        const identity = completionExternalGenerationIdentityFromSession(session);
        if (!identity) continue;
        const identityKey = completionExternalGenerationIdentityKey(identity);
        if (sessionsByIdentity.has(identityKey)) {
          sessionsByIdentity.set(identityKey, null);
          duplicateSessionIdentities.add(identityKey);
        } else {
          sessionsByIdentity.set(identityKey, session);
        }
      }
      const resolutionByIdentity = new Map<string, CompletionTargetResolution | null>();
      const duplicateResolutionIdentities = new Set<string>();
      for (const resolution of resolutions) {
        const identityKey = resolution.generationIdentityKey;
        if (resolutionByIdentity.has(identityKey)) {
          resolutionByIdentity.set(identityKey, null);
          duplicateResolutionIdentities.add(identityKey);
        } else {
          resolutionByIdentity.set(identityKey, resolution);
        }
      }
      for (const identityKey of new Set([...duplicateSessionIdentities, ...duplicateResolutionIdentities])) {
        const session = sessionsByIdentity.get(identityKey);
        emitDiagnostic({
          code: 'provider_id_conflict',
          ...(session ? diagnosticContext(session) : {}),
        });
      }
      for (const identityKey of readBackoff.keys()) {
        if (!sessionsByIdentity.has(identityKey)) readBackoff.delete(identityKey);
      }
      const completeObservations: Array<{ generationTargetId: number; paneEvidenceKey: string }> = [];
      const currentPaneRoster = new Set<string>();
      const replacementGenerationIdsByPane = new Map<string, Set<number>>();
      if (completeScan && duplicateSessionIdentities.size === 0 && duplicateResolutionIdentities.size === 0) {
        try {
          const generationTargetsByIdentity = new Map(
            listGenerationTargets().map((target) => [target.identityKey, target.id]),
          );
          for (const [identityKey, session] of sessionsByIdentity) {
            if (!session) continue;
            const paneEvidenceKey = completionExternalGenerationPaneEvidenceKey(session.tmux);
            currentPaneRoster.add(paneEvidenceKey);
            const generationTargetId = generationTargetsByIdentity.get(identityKey);
            if (generationTargetId === undefined) continue;
            completeObservations.push({ generationTargetId, paneEvidenceKey });
            const replacementGenerationIds = replacementGenerationIdsByPane.get(paneEvidenceKey) ?? new Set<number>();
            replacementGenerationIds.add(generationTargetId);
            replacementGenerationIdsByPane.set(paneEvidenceKey, replacementGenerationIds);
          }
          touchObservedGenerations(completeObservations, now());
        } catch {
          emitDiagnostic({ code: 'decision_unavailable' });
          return;
        }
      }

      for (const [identityKey, resolution] of resolutionByIdentity) {
        const session = sessionsByIdentity.get(identityKey);
        if (!session || !resolution) continue;
        const providerBinding = session.providerSessionId ?? null;
        let backoff = readBackoff.get(identityKey);
        if (backoff && backoff.providerBinding !== providerBinding) {
          readBackoff.delete(identityKey);
          backoff = undefined;
        }
        if (backoff && now() < backoff.nextReadAt) continue;

        let result: MonitorResolvedActivity | null;
        try {
          result = asResolvedActivity(await deps.resolve({
            ...session,
            ...(resolution.appSessionId ? { completionAppSessionId: resolution.appSessionId } : {}),
          }));
        } catch {
          result = null;
        }
        if (!result || (resolution.appSessionId && result.appSession?.session_id !== resolution.appSessionId)) {
          emitDiagnostic({ code: 'read_unavailable', ...diagnosticContext(session) });
          const failures = (backoff?.failures ?? 0) + 1;
          readBackoff.set(identityKey, {
            failures,
            nextReadAt: now() + Math.min(600_000, 5_000 * (2 ** Math.max(0, failures - 2))),
            providerBinding,
          });
          continue;
        }
        readBackoff.delete(identityKey);

        const outcome = result.terminalOutcome;
        const cursor = result.evidenceCursor;
        const activity = result.activity;
        if (result.transcriptEnded) {
          try {
            observeGeneration(resolution.generationTargetId, cursor, 'unknown');
          } catch {
            emitDiagnostic({ code: 'decision_unavailable', ...diagnosticContext(session) });
          }
          continue;
        }
        if (activity === 'running') {
          try {
            const transition = observeGeneration(resolution.generationTargetId, cursor, 'running');
            if (!transition.replay && transition.sequence !== null) {
              emitDiagnostic({ code: 'armed', ...diagnosticContext(session) });
            }
          } catch {
            emitDiagnostic({ code: 'decision_unavailable', ...diagnosticContext(session) });
          }
          continue;
        }
        if (outcome === 'reply_ready') {
          try {
            const decision = createTerminalDecision({
              generationTargetId: resolution.generationTargetId,
              evidenceCursor: cursor,
              eventCode: 'reply_ready',
              targetAliasSnapshot: resolution.target.alias,
              payload: completionPayload(session, resolution.target),
              now: now(),
            });
            if (decision.status === 'baselined') emitDiagnostic({ code: 'baselined', ...diagnosticContext(session) });
            if (decision.status === 'decided') {
              emitDiagnostic({ code: 'notified', ...diagnosticContext(session) });
              if (decision.decisionIds.length > 0) wake();
            }
          } catch {
            emitDiagnostic({ code: 'decision_unavailable', ...diagnosticContext(session) });
          }
          continue;
        }
        try {
          observeGeneration(
            resolution.generationTargetId,
            cursor,
            outcome === 'failed' ? 'failed' : activity === 'asking_user' ? 'asking' : 'unknown',
          );
        } catch {
          emitDiagnostic({ code: 'decision_unavailable', ...diagnosticContext(session) });
        }
      }
      if (completeScan && duplicateSessionIdentities.size === 0 && duplicateResolutionIdentities.size === 0) {
        try {
          const cutoff = now() - (30 * 24 * 60 * 60 * 1_000);
          const completeGenerationIds = new Set(completeObservations.map(({ generationTargetId }) => generationTargetId));

          const approvedGenerationTargetIds = listStaleGenerationCandidates(cutoff)
            .filter((candidate) => {
              if (completeGenerationIds.has(candidate.generationTargetId)) return false;
              if (!currentPaneRoster.has(candidate.paneEvidenceKey)) return true;
              return replacementGenerationIdsByPane.get(candidate.paneEvidenceKey)
                ?.has(candidate.generationTargetId) === false;
            })
            .map(({ generationTargetId }) => generationTargetId);
          const pruned = pruneStaleGenerationCandidates(cutoff, approvedGenerationTargetIds);
          for (let index = 0; index < pruned; index += 1) emitDiagnostic({ code: 'pruned' });
        } catch {
          emitDiagnostic({ code: 'decision_unavailable' });
        }
      }
    } catch {
      emitDiagnostic({ code: 'unexpected_tick_failure' });
    } finally {
      ticking = false;
    }
  };

  return { tick, generationCount, stats: () => Object.freeze({ ...stats }) };
}

export function startExternalTurnMonitor(
  intervalMs = DEFAULT_INTERVAL_MS,
  getDetailed: () => Promise<ExternalCliSessionsDetailedResult> = getExternalCliSessionsDetailed,
): (() => void) | null {
  if (process.env.CHATMUX_LIVE_NOTIFY === '0') return null;
  const monitor = createExternalTurnMonitor({
    getDetailed,
    resolve: resolveExternalSessionActivity,
    getUserId: () => {
      try {
        return userDb.getFirstUser()?.id ?? null;
      } catch {
        return null;
      }
    },
    diagnostic: createRateLimitedProductionDiagnosticSink(),
  });
  return startEventDrivenMonitorLoop({
    tick: monitor.tick,
    subscribe: onTranscriptChanged,
    accepts: (change) => EVENT_DRIVEN_EXTERNAL_PROVIDERS.has(change.provider),
    fallbackMs: intervalMs,
  });
}
