import { accessSync, constants as fsConstants } from 'node:fs';


import {
  completionAppAlias,
  completionAppIdentityKey,
  completionExternalGenerationAlias,
  completionExternalGenerationIdentityFromSession,
  completionExternalGenerationIdentityKey,
  completionNotificationTargetsDb,
  getConnection,
  type CompletionAppIdentity,
} from '@/modules/database/index.js';
import type { ExternalCliSession, ExternalCliSessionsDetailedResult } from '@/modules/providers/index.js';

import type {
  CompletionNotificationMappingState,
  CompletionNotificationStatusItem,
  CompletionNotificationTarget,
} from '../../../../shared/completion-notifications.js';

type AppSessionRow = {
  session_id: string;
  provider: string;
  jsonl_path: string | null;
  active: number;
};
const EXTERNAL_COMPLETION_PROVIDERS = new Set<ExternalCliSession['kind']>([
  'claude',
  'codex',
  'opencode',
  'omp',
]);
const APP_COMPLETION_PROVIDERS = new Set(['claude', 'codex', 'opencode', 'gjc']);

function hasMappedActivityEvidence(session: ExternalCliSession, app: AppSessionRow): boolean {
  if (session.kind === 'opencode') return true;
  if (!app.jsonl_path) return false;
  try {
    accessSync(app.jsonl_path, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}


/** Cursor is deliberately excluded until it has a completion activity resolver. */
export function isSupportedExternalCompletionProvider(session: ExternalCliSession): boolean {
  return EXTERNAL_COMPLETION_PROVIDERS.has(session.kind);
}

const PROJECT_EXISTS_PREDICATE = `
  project.project_path IS NOT NULL
`;

export type CompletionTargetResolution = Readonly<{
  /** Server-internal durable generation state key. Never serialize this to browser/API clients. */
  generationTargetId: number;
  /** Opaque server-only key that binds this result to its exact generation. */
  generationIdentityKey: string;
  /** The active app row selected for transcript lineage, when unambiguous. */
  appSessionId: string | null;
  target: CompletionNotificationTarget;
  mappingState: CompletionNotificationMappingState;
}>;


function appSessionsForExternal(session: ExternalCliSession): AppSessionRow[] {
  if (typeof session.providerSessionId !== 'string') return [];
  return getConnection().prepare(`
    SELECT session.session_id, session.provider, session.jsonl_path,
      CASE WHEN ${PROJECT_EXISTS_PREDICATE} THEN 1 ELSE 0 END AS active
    FROM sessions session
    LEFT JOIN projects project ON project.project_path = session.project_path
    WHERE session.provider = ? AND session.provider_session_id = ?
    ORDER BY session.session_id
  `).all(session.kind, session.providerSessionId) as AppSessionRow[];
}

function appSessionsForIdentity(identity: CompletionAppIdentity): AppSessionRow[] {
  return getConnection().prepare(`
    SELECT session.session_id, session.provider, session.jsonl_path,
      CASE WHEN ${PROJECT_EXISTS_PREDICATE} THEN 1 ELSE 0 END AS active
    FROM sessions session
    LEFT JOIN projects project ON project.project_path = session.project_path
    WHERE session.provider = ? AND session.session_id = ?
    ORDER BY session.session_id
  `).all(identity.provider, identity.sessionId) as AppSessionRow[];
}

function mappingStatus(
  alias: string,
  mappingState: CompletionNotificationMappingState,
): Exclude<CompletionNotificationStatusItem, { reason: 'eligible' }> {
  switch (mappingState) {
    case 'none':
      return { alias, mappingState, reason: 'not_found' };
    case 'ambiguous_active':
      return { alias, mappingState, reason: 'identity_ambiguous' };
    case 'inactive_match':
      return { alias, mappingState, reason: 'identity_inactive' };
    case 'one_active':
      throw new Error('eligible mapping requires a target');
  }
}
function generationTargetId(identityKey: string): number {
  const row = getConnection().prepare(
    'SELECT id FROM completion_notification_targets WHERE identity_key = ? AND kind = ?',
  ).get(identityKey, 'external_generation') as { id: number } | undefined;
  if (!row) throw new Error('completion generation target is missing');
  return row.id;
}
function throwCompletionTargetIdentityConflict(
  stage: 'pre_promotion' | 'post_promotion',
  target: { id: number; kind: string; identity_key: string },
): never {
  throw new Error(`completion target identity conflict: ${JSON.stringify({
    diagnosticCode: 'completion_target_identity_conflict',
    stage,
    actualTargetId: target.id,
    actualKind: target.kind,
  })}`);
}


function targetView(
  target: { id: number; kind: CompletionNotificationTarget['kind']; revision: number },
  alias: string,
  userId: number,
): CompletionNotificationTarget {
  return {
    alias,
    kind: target.kind,
    revision: target.revision,
    watched: completionNotificationTargetsDb.getWatch(userId, target.id),
  };
}

function resolveExternalCompletionTarget(
  external: ExternalCliSession,
  userId: number,
): CompletionTargetResolution | null {
  const generationIdentity = completionExternalGenerationIdentityFromSession(external);
  if (!generationIdentity) return null;

  const generationIdentityKey = completionExternalGenerationIdentityKey(generationIdentity);
  const matches = appSessionsForExternal(external);
  const active = matches.filter((match) => match.active === 1);
  const mappingState = completionNotificationTargetsDb.mappingState(matches.length, active.length);
  if (mappingState === 'one_active' && !hasMappedActivityEvidence(external, active[0])) return null;

  const generationAlias = completionExternalGenerationAlias(generationIdentity);
  const generationTarget = completionNotificationTargetsDb.createTarget(
    generationIdentityKey,
    'external_generation',
    [generationAlias],
  );
  const generationId = generationTargetId(generationIdentityKey);

  if (mappingState === 'none') {
    return {
      generationTargetId: generationId,
      generationIdentityKey,
      appSessionId: null,
      target: targetView(generationTarget, generationAlias, userId),
      mappingState,
    };
  }
  if (mappingState !== 'one_active') return null;

  const app = active[0];
  const appIdentity = { provider: app.provider, sessionId: app.session_id };
  const expectedIdentityKey = completionAppIdentityKey(appIdentity);
  const selectedAppTarget = completionNotificationTargetsDb.createTarget(
    expectedIdentityKey,
    'app',
  );
  if (
    selectedAppTarget.kind !== 'app'
    || selectedAppTarget.identity_key !== expectedIdentityKey
  ) {
    throwCompletionTargetIdentityConflict('pre_promotion', selectedAppTarget);
  }
  const appTarget = completionNotificationTargetsDb.promoteGenerationToApp(
    generationIdentityKey,
    expectedIdentityKey,
    [completionAppAlias(appIdentity)],
    [generationAlias],
  );
  if (appTarget.kind !== 'app' || appTarget.identity_key !== expectedIdentityKey) {
    throwCompletionTargetIdentityConflict('post_promotion', appTarget);
  }
  return {
    generationTargetId: generationId,
    generationIdentityKey,
    appSessionId: app.session_id,
    target: targetView(appTarget, completionAppAlias(appIdentity), userId),
    mappingState,
  };
}

/**
 * Resolves exactly one completed detailed discovery scan. Its durable generation
 * ID is server-internal; the target view remains browser-safe.
 */
export function resolveCompletionTargetsFromDetailedScan(
  detailed: ExternalCliSessionsDetailedResult,
  userId: number,
): CompletionTargetResolution[] {
  if (!detailed.ok) return [];

  const resolutions: CompletionTargetResolution[] = [];
  const identityCounts = new Map<string, number>();
  for (const external of detailed.sessions) {
    if (!isSupportedExternalCompletionProvider(external)) continue;
    const identity = completionExternalGenerationIdentityFromSession(external);
    if (!identity) continue;
    const identityKey = completionExternalGenerationIdentityKey(identity);
    identityCounts.set(identityKey, (identityCounts.get(identityKey) ?? 0) + 1);
  }

  for (const external of detailed.sessions) {
    if (!isSupportedExternalCompletionProvider(external)) continue;
    const generationIdentity = completionExternalGenerationIdentityFromSession(external);
    if (!generationIdentity) continue;

    const generationIdentityKey = completionExternalGenerationIdentityKey(generationIdentity);
    if (identityCounts.get(generationIdentityKey) !== 1) continue;
    try {
      const resolution = resolveExternalCompletionTarget(external, userId);
      if (resolution) resolutions.push(resolution);
    } catch {
      // Keep failures local to one generation. A stale mapping is retried on
      // the next authoritative scan and cannot hide unrelated session bells.
    }
  }
  return resolutions;
}

/** Resolves a direct app descriptor without relying on discovery-session correlation. */
export function resolveCompletionAppDescriptor(
  identity: CompletionAppIdentity,
  userId: number,
): CompletionNotificationStatusItem {
  const alias = completionAppAlias(identity);
  if (!APP_COMPLETION_PROVIDERS.has(identity.provider)) {
    return { alias, mappingState: 'none', reason: 'not_found' };
  }

  const matches = appSessionsForIdentity(identity);
  const active = matches.filter((match) => match.active === 1);
  const mappingState = completionNotificationTargetsDb.mappingState(matches.length, active.length);
  if (mappingState !== 'one_active') return mappingStatus(alias, mappingState);

  const identityKey = completionAppIdentityKey(identity);
  const target = completionNotificationTargetsDb.createTarget(identityKey, 'app', [alias]);
  if (target.kind !== 'app' || target.identity_key !== identityKey) {
    throw new Error('completion app target identity conflict');
  }
  return {
    alias,
    mappingState,
    reason: 'eligible',
    target: targetView(target, alias, userId),
  };
}

/** Produces browser-safe status for external-generation descriptors from one discovery scan. */
export function resolveExternalCompletionStatusesFromDetailedScan(
  detailed: ExternalCliSessionsDetailedResult,
  userId: number,
): CompletionNotificationStatusItem[] {
  if (!detailed.ok) return [];

  const counts = new Map<string, number>();
  const sessions = new Map<string, ExternalCliSession>();
  for (const external of detailed.sessions) {
    if (!isSupportedExternalCompletionProvider(external)) continue;
    const identity = completionExternalGenerationIdentityFromSession(external);
    if (!identity) continue;
    const identityKey = completionExternalGenerationIdentityKey(identity);
    counts.set(identityKey, (counts.get(identityKey) ?? 0) + 1);
    sessions.set(identityKey, external);
  }

  const resolved = new Map(
    resolveCompletionTargetsFromDetailedScan(detailed, userId)
      .map((resolution) => [resolution.generationIdentityKey, resolution]),
  );
  const statuses: CompletionNotificationStatusItem[] = [];
  for (const [identityKey, external] of sessions) {
    const identity = completionExternalGenerationIdentityFromSession(external);
    if (!identity) continue;
    const alias = completionExternalGenerationAlias(identity);
    if (counts.get(identityKey) !== 1) {
      statuses.push({ alias, mappingState: 'ambiguous_active', reason: 'identity_ambiguous' });
      continue;
    }

    const resolution = resolved.get(identityKey);
    if (
      resolution?.mappingState === 'one_active'
      || resolution?.mappingState === 'none'
    ) {
      statuses.push({
        alias,
        mappingState: resolution.mappingState,
        reason: 'eligible',
        target: { ...resolution.target, alias },
      });
      continue;
    }

    const matches = appSessionsForExternal(external);
    const active = matches.filter((match) => match.active === 1);
    if (active.length === 1 && !hasMappedActivityEvidence(external, active[0])) {
      statuses.push({ alias, mappingState: 'none', reason: 'not_found' });
      continue;
    }
    const mappingState = completionNotificationTargetsDb.mappingState(matches.length, active.length);
    statuses.push(mappingState === 'one_active'
      ? { alias, mappingState: 'none', reason: 'not_found' }
      : mappingStatus(alias, mappingState));
  }
  return statuses;
}

export const completionTargetResolver = {
  resolveAppDescriptor: resolveCompletionAppDescriptor,
  resolveDetailedScan: resolveCompletionTargetsFromDetailedScan,
  resolveExternalStatuses: resolveExternalCompletionStatusesFromDetailedScan,
};
