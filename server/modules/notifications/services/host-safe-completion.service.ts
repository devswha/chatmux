import {
  completionAppAlias,
  completionAppIdentityKey,
  completionNotificationOutboxDb,
  sessionsDb,
} from '@/modules/database/index.js';
import { fleetCompletionPeerGateway } from '@/modules/fleet/index.js';

import { wakeCompletionOutboxDispatcher } from './completion-outbox-dispatcher.service.js';

const PROVIDER_LABELS: Readonly<Record<string, string>> = {
  claude: 'Claude', cursor: 'Cursor', codex: 'Codex', opencode: 'OpenCode',
  omp: 'Oh My Pi', omo: 'Oh My OpenAgent', gjc: 'GJC', system: 'System',
};

type CompletionDecisionInput = Readonly<{
  readonly userId: number;
  readonly target: Readonly<{ readonly provider: string; readonly sessionId: string }>;
  readonly event: Readonly<{
    readonly code: 'reply_ready';
    readonly occurrenceKey: string;
    readonly preferenceClass: 'stop' | 'liveStop';
    readonly sessionName?: string | null;
    readonly stopReason?: 'completed';
  }>;
}>;

function normalizeSessionName(sessionName: unknown): string | null {
  if (typeof sessionName !== 'string') return null;
  const normalized = sessionName.replace(/\s+/g, ' ').trim();
  if (!normalized) return null;
  return normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized;
}

function normalizedSessionId(provider: string, sessionId: string): string {
  const direct = sessionsDb.getSessionById(sessionId);
  if (direct?.provider === provider) return direct.session_id;
  return sessionsDb.getSessionByProviderSessionId(provider, sessionId)?.session_id ?? sessionId;
}

export function buildCompletionPayload(input: Readonly<{
  readonly provider: string;
  readonly sessionId: string;
  readonly sessionName?: string | null;
}>): Readonly<{
  readonly title: string;
  readonly body: string;
  readonly navigation: Readonly<{ readonly href: string; readonly title: string }>;
}> {
  const title = normalizeSessionName(input.sessionName) ?? 'ChatMux';
  return {
    title,
    body: `${PROVIDER_LABELS[input.provider] ?? 'Assistant'}: Reply ready`,
    navigation: { href: `/session/${encodeURIComponent(input.sessionId)}`, title },
  };
}

function validateCompletionDecision(input: CompletionDecisionInput): void {
  if (!Number.isInteger(input.userId) || input.userId < 1
    || !input.target.provider || !input.target.sessionId
    || input.event.code !== 'reply_ready'
    || !input.event.occurrenceKey.trim()
    || (input.event.stopReason !== undefined && input.event.stopReason !== 'completed')) {
    throw new TypeError('completion decision requires an owner, preference class, reply_ready, a normal completion, and a stable occurrence key');
  }
}

export function createCompletionDecision(input: CompletionDecisionInput): number[] {
  validateCompletionDecision(input);
  const sessionId = normalizedSessionId(input.target.provider, input.target.sessionId);
  const identity = { provider: input.target.provider, sessionId };
  const sessionName = normalizeSessionName(input.event.sessionName);
  fleetCompletionPeerGateway.app({
    provider: input.target.provider, localId: sessionId,
    occurrenceKey: input.event.occurrenceKey, sessionLabel: sessionName,
  });
  const decisions = completionNotificationOutboxDb.createApplicationDecision({
    userId: input.userId,
    preferenceClass: input.event.preferenceClass,
    targetIdentityKey: completionAppIdentityKey(identity),
    provider: input.target.provider,
    sessionId,
    eventOccurrenceKey: input.event.occurrenceKey,
    eventCode: 'reply_ready',
    targetAliasSnapshot: completionAppAlias(identity),
    payload: buildCompletionPayload({ provider: input.target.provider, sessionId, sessionName }),
    now: Date.now(),
  });
  if (decisions.length > 0) wakeCompletionOutboxDispatcher();
  return decisions;
}

export function notifyRunStopped(input: Readonly<{
  readonly userId: number;
  readonly provider: string;
  readonly sessionId?: string | null;
  readonly stopReason?: string;
  readonly sessionName?: string | null;
  readonly completionKey?: string | null;
}>): void {
  if (input.stopReason !== undefined && input.stopReason !== 'completed') return;
  if (input.sessionId === null || input.sessionId === undefined
    || input.completionKey === null || input.completionKey === undefined) {
    throw new TypeError('completed run requires a session and stable completion key');
  }
  createCompletionDecision({
    userId: input.userId, target: { provider: input.provider, sessionId: input.sessionId },
    event: {
      code: 'reply_ready', preferenceClass: 'stop', occurrenceKey: input.completionKey,
      sessionName: input.sessionName, stopReason: 'completed',
    },
  });
}

export function notifyLiveTurnEnded(input: Readonly<{
  readonly userId: number;
  readonly provider?: string;
  readonly sessionId: string | null;
  readonly tmuxName?: string | null;
  readonly stopReason?: string;
  readonly completionKey?: string | null;
}>): void {
  if (input.stopReason !== undefined && input.stopReason !== 'completed') return;
  const provider = input.provider ?? 'gjc';
  if (provider !== 'gjc') throw new RangeError('live turn completion decisions are only supported for GJC');
  if (input.sessionId === null || input.completionKey === null || input.completionKey === undefined) {
    throw new TypeError('completed live turn requires a session and stable completion key');
  }
  createCompletionDecision({
    userId: input.userId, target: { provider, sessionId: input.sessionId },
    event: {
      code: 'reply_ready', preferenceClass: 'liveStop', occurrenceKey: input.completionKey,
      sessionName: input.tmuxName, stopReason: 'completed',
    },
  });
}
