import Database from 'better-sqlite3';

import { getConnection } from '@/modules/database/connection.js';

import type {
  CompletionNotificationMappingState,
  CompletionNotificationMutation,
  CompletionNotificationMutationResult,
  CompletionNotificationTargetKind,
} from '../../../../shared/completion-notifications.js';

type TargetRow = {
  id: number;
  identity_key: string;
  kind: CompletionNotificationTargetKind;
  canonical_target_id: number | null;
  revision: number;
};
export function resolveCanonicalCompletionTarget(
  db: Database.Database,
  targetId: number,
): CanonicalCompletionTarget | undefined {
  const target = db.prepare(`
    SELECT id, identity_key, kind, canonical_target_id, revision
    FROM completion_notification_targets
    WHERE id = ?
  `).get(targetId) as TargetRow | undefined;
  if (!target) return undefined;
  if (target.canonical_target_id === null) return target;

  const canonical = db.prepare(`
    SELECT id, identity_key, kind, canonical_target_id, revision
    FROM completion_notification_targets
    WHERE id = ?
  `).get(target.canonical_target_id) as TargetRow | undefined;
  if (!canonical || canonical.kind !== 'app' || canonical.canonical_target_id !== null) {
    throw new Error('completion notification target redirect invariant violated');
  }
  return canonical;
}

type GenerationStateRow = {
  generation_target_id: number;
  high_water_seq: number;
  armed_seq: number | null;
  monitor_state: 'unobserved' | 'running' | 'terminal';
  last_evidence_cursor: string | null;
  state_revision: number;
};

export type CanonicalCompletionTarget = Pick<TargetRow, 'id' | 'identity_key' | 'kind' | 'revision'>;
export type DurableGenerationTarget = Pick<TargetRow, 'id'> & { identityKey: string };
export type GenerationObservation = 'running' | 'failed' | 'asking' | 'aborted' | 'unknown' | 'unavailable';
export type GenerationTransition = {
  state: GenerationStateRow['monitor_state'];
  sequence: number | null;
  replay: boolean;
  stateRevision: number;
};
export type GenerationPruneObservation = Readonly<{
  generationTargetId: number;
  paneEvidenceKey: string;
}>;

export type StaleGenerationCandidate = Readonly<{
  generationTargetId: number;
  paneEvidenceKey: string;
  lastSeenAt: number;
}>;

function assertPruneTimestamp(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
}

function assertGenerationPruneObservation(observation: GenerationPruneObservation): void {
  if (!Number.isSafeInteger(observation.generationTargetId) || observation.generationTargetId <= 0) {
    throw new TypeError('generationTargetId must be a positive safe integer');
  }
  if (typeof observation.paneEvidenceKey !== 'string' || !observation.paneEvidenceKey) {
    throw new TypeError('paneEvidenceKey must be a nonempty string');
  }
}



export class CompletionNotificationTargetsRepository {
  constructor(private readonly injectedDb?: Database.Database) {}

  private get db(): Database.Database {
    return this.injectedDb ?? getConnection();
  }
  createTarget(identityKey: string, kind: CompletionNotificationTargetKind, aliases: string[] = []): CanonicalCompletionTarget {
    const create = this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO completion_notification_targets (identity_key, kind)
        VALUES (?, ?)
        ON CONFLICT(identity_key) DO NOTHING
      `).run(identityKey, kind);
      const row = this.db.prepare(
        'SELECT id, identity_key, kind, revision FROM completion_notification_targets WHERE identity_key = ?',
      ).get(identityKey) as CanonicalCompletionTarget | undefined;
      if (!row || row.kind !== kind) throw new Error('completion target identity kind conflict');
      const target = this.resolveTarget(row.id);
      if (!target) throw new Error('completion target canonical target is missing');
      for (const alias of new Set(aliases)) {
        const existing = this.db.prepare('SELECT target_id FROM completion_notification_aliases WHERE alias = ?')
          .get(alias) as { target_id: number } | undefined;
        if (existing && this.resolveTarget(existing.target_id)?.id !== target.id) {
          throw new Error('completion notification alias is already owned by another target');
        }
        if (!existing) {
          this.db.prepare('INSERT INTO completion_notification_aliases (alias, target_id) VALUES (?, ?)').run(alias, target.id);
        }
      }
      return target;
    });
    return create();
  }

  resolveAlias(alias: string): CanonicalCompletionTarget | undefined {
    const row = this.db.prepare('SELECT target_id FROM completion_notification_aliases WHERE alias = ?').get(alias) as { target_id: number } | undefined;
    return row ? this.resolveTarget(row.target_id) : undefined;
  }

  resolveTarget(targetId: number): CanonicalCompletionTarget | undefined {
    return resolveCanonicalCompletionTarget(this.db, targetId);
  }

  setWatch(userId: number, mutation: CompletionNotificationMutation): CompletionNotificationMutationResult {
    return this.db.transaction(() => {
      const prior = this.db.prepare(`SELECT alias, expected_revision, watched, target_id, result_kind, result_revision,
        result_global_paused
        FROM completion_notification_watch_mutations WHERE user_id = ? AND mutation_id = ?`)
        .get(userId, mutation.mutationId) as {
          alias: string; expected_revision: number; watched: number; target_id: number | null;
          result_kind: CompletionNotificationTargetKind; result_revision: number; result_global_paused: number;
        } | undefined;
      if (prior) {
        if (prior.alias !== mutation.alias || prior.expected_revision !== mutation.expectedRevision ||
          Boolean(prior.watched) !== mutation.watched) {
          return { ok: false, reason: 'mutation_replay_conflict' } as const;
        }
        return {
          ok: true as const,
          target: {
            alias: prior.alias,
            kind: prior.result_kind,
            revision: prior.result_revision,
            watched: Boolean(prior.watched),
          },
          globalPaused: Boolean(prior.result_global_paused),
        };
      }

      const target = this.resolveAlias(mutation.alias);
      if (!target) return { ok: false, reason: 'not_found' } as const;
      if (target.revision !== mutation.expectedRevision) {
        const watched = Boolean(this.db.prepare(
          'SELECT 1 FROM completion_notification_watches WHERE user_id = ? AND target_id = ?',
        ).get(userId, target.id));
        return {
          ok: false,
          reason: 'revision_conflict',
          target: {
            alias: mutation.alias,
            kind: target.kind,
            revision: target.revision,
            watched,
          },
        } as const;
      }
      const alreadyWatched = Boolean(this.db.prepare(
        'SELECT 1 FROM completion_notification_watches WHERE user_id = ? AND target_id = ?',
      ).get(userId, target.id));
      if (alreadyWatched !== mutation.watched) {
        this.db.prepare(`UPDATE completion_notification_targets
          SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND revision = ?`)
          .run(target.id, mutation.expectedRevision);
      }
      if (mutation.watched) {
        this.db.prepare(`INSERT INTO completion_notification_watches (user_id, target_id) VALUES (?, ?)
          ON CONFLICT(user_id, target_id) DO UPDATE SET updated_at = CURRENT_TIMESTAMP`).run(userId, target.id);
      } else {
        this.db.prepare('DELETE FROM completion_notification_watches WHERE user_id = ? AND target_id = ?').run(userId, target.id);
      }
      const updated = this.resolveTarget(target.id)!;
      const globalPaused = !this.db.prepare(`SELECT 1 FROM completion_notification_policy
        WHERE user_id = ? AND desired_web_push = 1 AND enforcement_enabled = 1`).get(userId);
      this.db.prepare(`INSERT INTO completion_notification_watch_mutations
        (user_id, mutation_id, alias, expected_revision, watched, target_id, result_kind, result_revision, result_global_paused)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        userId, mutation.mutationId, mutation.alias, mutation.expectedRevision, Number(mutation.watched), updated.id,
        updated.kind, updated.revision, Number(globalPaused),
      );
      return {
        ok: true as const,
        target: { alias: mutation.alias, kind: updated.kind, revision: updated.revision, watched: mutation.watched },
        globalPaused,
      };
    })();
  }

  getWatch(userId: number, targetId: number): boolean {
    const canonical = this.resolveTarget(targetId);
    return Boolean(canonical && this.db.prepare(
      'SELECT 1 FROM completion_notification_watches WHERE user_id = ? AND target_id = ?',
    ).get(userId, canonical.id));
  }
  promoteGenerationToApp(
    generationIdentityKey: string,
    appIdentityKey: string,
    appAliases: string[] = [],
  ): CanonicalCompletionTarget {
    return this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO completion_notification_targets (identity_key, kind)
        VALUES (?, 'app')
        ON CONFLICT(identity_key) DO NOTHING
      `).run(appIdentityKey);
      const appRow = this.db.prepare(
        'SELECT id, identity_key, kind FROM completion_notification_targets WHERE identity_key = ?',
      ).get(appIdentityKey) as { id: number; identity_key: string; kind: string } | undefined;
      if (!appRow || appRow.kind !== 'app') {
        throw new Error('generation promotion requires an app target with the expected identity');
      }
      const app = this.resolveTarget(appRow.id);
      if (!app || app.kind !== 'app' || app.identity_key !== appIdentityKey) {
        throw new Error('generation promotion app canonical identity conflict');
      }

      const generation = this.db.prepare(
        'SELECT id, kind, canonical_target_id FROM completion_notification_targets WHERE identity_key = ?',
      ).get(generationIdentityKey) as { id: number; kind: string; canonical_target_id: number | null } | undefined;
      if (!generation || generation.kind !== 'external_generation') {
        throw new Error('generation promotion requires an external generation target');
      }
      const generationCanonical = this.resolveTarget(generation.id);
      if (
        generation.canonical_target_id !== null
        && (!generationCanonical || generationCanonical.id !== app.id
          || generationCanonical.identity_key !== appIdentityKey)
      ) {
        throw new Error('generation promotion canonical identity conflict');
      }

      for (const alias of new Set(appAliases)) {
        const existing = this.db.prepare('SELECT target_id FROM completion_notification_aliases WHERE alias = ?')
          .get(alias) as { target_id: number } | undefined;
        if (existing && this.resolveTarget(existing.target_id)?.id !== app.id) {
          throw new Error('completion notification alias is already owned by another target');
        }
        if (!existing) {
          this.db.prepare('INSERT INTO completion_notification_aliases (alias, target_id) VALUES (?, ?)').run(alias, app.id);
        }
      }

      if (generation.canonical_target_id === null) {
        this.db.prepare('UPDATE completion_notification_aliases SET target_id = ? WHERE target_id = ?')
          .run(app.id, generation.id);
        this.db.prepare(`INSERT INTO completion_notification_watches (user_id, target_id)
          SELECT user_id, ? FROM completion_notification_watches WHERE target_id = ?
          ON CONFLICT(user_id, target_id) DO NOTHING`).run(app.id, generation.id);
        this.db.prepare('DELETE FROM completion_notification_watches WHERE target_id = ?').run(generation.id);
        this.db.prepare(`UPDATE completion_notification_targets
          SET canonical_target_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
          .run(app.id, generation.id);
        this.db.prepare(`UPDATE completion_notification_targets
          SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(app.id);
      }
      const promoted = this.resolveTarget(generation.id);
      if (!promoted || promoted.id !== app.id || promoted.identity_key !== appIdentityKey) {
        throw new Error('generation promotion verification failed');
      }
      return promoted;
    })();
  }

  observeGeneration(generationTargetId: number, evidenceCursor: string, observation: GenerationObservation): GenerationTransition {
    return this.db.transaction((): GenerationTransition => {
      const target = this.db.prepare('SELECT kind FROM completion_notification_targets WHERE id = ?').get(generationTargetId) as { kind: string } | undefined;
      if (target?.kind !== 'external_generation') throw new Error('generation state requires an external generation target');
      let row = this.db.prepare('SELECT * FROM completion_notification_generation_state WHERE generation_target_id = ?').get(generationTargetId) as GenerationStateRow | undefined;
      if (!row) {
        if (observation === 'unavailable') {
          return { state: 'unobserved', sequence: null, replay: true, stateRevision: 0 };
        }
        if (observation !== 'running') {
          this.db.prepare(`INSERT INTO completion_notification_generation_state
            (generation_target_id, monitor_state, last_evidence_cursor)
            VALUES (?, 'terminal', ?)`).run(generationTargetId, evidenceCursor);
          return { state: 'terminal', sequence: null, replay: false, stateRevision: 1 };
        }
        this.db.prepare(`INSERT INTO completion_notification_generation_state
          (generation_target_id, high_water_seq, armed_seq, monitor_state, last_evidence_cursor)
          VALUES (?, 1, 1, 'running', ?)`).run(generationTargetId, evidenceCursor);
        row = this.db.prepare('SELECT * FROM completion_notification_generation_state WHERE generation_target_id = ?').get(generationTargetId) as GenerationStateRow;
        return { state: row.monitor_state, sequence: row.armed_seq, replay: false, stateRevision: row.state_revision };
      }
      if (observation === 'unavailable' || row.last_evidence_cursor === evidenceCursor) {
        return { state: row.monitor_state, sequence: row.armed_seq, replay: true, stateRevision: row.state_revision };
      }
      if (observation !== 'running') {
        this.db.prepare(`UPDATE completion_notification_generation_state
          SET armed_seq = NULL, monitor_state = 'terminal', last_evidence_cursor = ?,
              state_revision = state_revision + 1, updated_at = CURRENT_TIMESTAMP
          WHERE generation_target_id = ? AND state_revision = ?`)
          .run(evidenceCursor, generationTargetId, row.state_revision);
        return { state: 'terminal', sequence: null, replay: false, stateRevision: row.state_revision + 1 };
      }
      const sequence = row.armed_seq ?? row.high_water_seq + 1;
      const highWater = row.armed_seq === null ? sequence : row.high_water_seq;
      this.db.prepare(`UPDATE completion_notification_generation_state
        SET high_water_seq = ?, armed_seq = ?, monitor_state = 'running', last_evidence_cursor = ?,
            state_revision = state_revision + 1, updated_at = CURRENT_TIMESTAMP
        WHERE generation_target_id = ? AND state_revision = ?`)
        .run(highWater, sequence, evidenceCursor, generationTargetId, row.state_revision);
      return { state: 'running', sequence, replay: false, stateRevision: row.state_revision + 1 };
    })();
  }
  generationCount(): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM completion_notification_targets
      WHERE kind = 'external_generation'
    `).get() as { count: number };
    return row.count;
  }
  listGenerationTargets(): DurableGenerationTarget[] {
    return (this.db.prepare(`
      SELECT id, identity_key
      FROM completion_notification_targets
      WHERE kind = 'external_generation'
    `).all() as Array<Pick<TargetRow, 'id' | 'identity_key'>>).map((target) => ({
      id: target.id,
      identityKey: target.identity_key,
    }));
  }
  /**
   * Records authoritative successful-scan evidence. Callers must supply every
   * complete observed generation; unavailable scans must not call this method.
   */
  touchObservedGenerations(observations: readonly GenerationPruneObservation[], lastSeenAt: number): void {
    assertPruneTimestamp(lastSeenAt, 'lastSeenAt');
    const uniqueObservations = new Map<number, string>();
    for (const observation of observations) {
      assertGenerationPruneObservation(observation);
      const priorPaneEvidenceKey = uniqueObservations.get(observation.generationTargetId);
      if (priorPaneEvidenceKey !== undefined && priorPaneEvidenceKey !== observation.paneEvidenceKey) {
        throw new Error('generation cannot have conflicting pane evidence in one scan');
      }
      uniqueObservations.set(observation.generationTargetId, observation.paneEvidenceKey);
    }

    this.db.transaction(() => {
      for (const [generationTargetId, paneEvidenceKey] of uniqueObservations) {
        const target = this.db.prepare('SELECT kind FROM completion_notification_targets WHERE id = ?')
          .get(generationTargetId) as { kind: string } | undefined;
        if (target?.kind !== 'external_generation') {
          throw new Error('generation evidence requires an external generation target');
        }
        this.db.prepare(`
          INSERT INTO completion_notification_generation_state
            (generation_target_id, pane_evidence_key, last_seen_at)
          VALUES (?, ?, ?)
          ON CONFLICT(generation_target_id) DO UPDATE SET
            pane_evidence_key = excluded.pane_evidence_key,
            last_seen_at = excluded.last_seen_at,
            updated_at = CURRENT_TIMESTAMP
        `).run(generationTargetId, paneEvidenceKey, lastSeenAt);
      }
    })();
  }

  listStaleGenerationCandidates(cutoff: number): StaleGenerationCandidate[] {
    assertPruneTimestamp(cutoff, 'cutoff');
    return (this.db.prepare(`
      SELECT g.generation_target_id, g.pane_evidence_key, g.last_seen_at
      FROM completion_notification_generation_state g
      JOIN completion_notification_targets t ON t.id = g.generation_target_id
      WHERE t.kind = 'external_generation'
        AND g.pane_evidence_key IS NOT NULL
        AND length(g.pane_evidence_key) > 0
        AND g.last_seen_at IS NOT NULL
        AND typeof(g.last_seen_at) = 'integer'
        AND g.last_seen_at BETWEEN 0 AND 9007199254740991
        AND g.last_seen_at < ?
      ORDER BY g.last_seen_at ASC, g.generation_target_id ASC
    `).all(cutoff) as Array<{
      generation_target_id: number;
      pane_evidence_key: string;
      last_seen_at: number;
    }>).map((candidate) => ({
      generationTargetId: candidate.generation_target_id,
      paneEvidenceKey: candidate.pane_evidence_key,
      lastSeenAt: candidate.last_seen_at,
    }));
  }

  /**
   * Removes only monitor-approved generations with complete durable metadata
   * strictly older than cutoff. The monitor must prove absence or replacement
   * from one authoritative complete scan; this repository never bulk-prunes.
   */
  pruneStaleGenerationCandidates(cutoff: number, approvedGenerationTargetIds: readonly number[]): number {
    assertPruneTimestamp(cutoff, 'cutoff');
    const approvedIds = [...new Set(approvedGenerationTargetIds)];
    for (const generationTargetId of approvedIds) {
      if (!Number.isSafeInteger(generationTargetId) || generationTargetId <= 0) {
        throw new TypeError('approved generation target IDs must be positive safe integers');
      }
    }
    return this.db.transaction(() => {
      let pruned = 0;
      for (const generationTargetId of approvedIds) {
        const stateDeleted = this.db.prepare(`
          DELETE FROM completion_notification_generation_state
          WHERE generation_target_id = ?
            AND pane_evidence_key IS NOT NULL
            AND length(pane_evidence_key) > 0
            AND last_seen_at IS NOT NULL
            AND typeof(last_seen_at) = 'integer'
            AND last_seen_at BETWEEN 0 AND 9007199254740991
            AND last_seen_at < ?
            AND EXISTS (
              SELECT 1 FROM completion_notification_targets
              WHERE id = completion_notification_generation_state.generation_target_id
                AND kind = 'external_generation'
            )
        `).run(generationTargetId, cutoff);
        if (stateDeleted.changes !== 1) continue;
        pruned += this.db.prepare(`
          DELETE FROM completion_notification_targets
          WHERE id = ? AND kind = 'external_generation'
        `).run(generationTargetId).changes;
      }
      return pruned;
    })();
  }

  mergeEquivalentApps(
    loserTargetIds: number[],
    survivorTargetId: number,
    proveEquivalent: () => boolean,
  ): CanonicalCompletionTarget {
    return this.db.transaction(() => {
      const losers = [...new Set(loserTargetIds)].sort((left, right) => left - right);
      if (losers.length === 0 || losers.includes(survivorTargetId)) {
        throw new Error('duplicate merge requires distinct loser app targets');
      }
      const placeholders = losers.map(() => '?').join(', ');
      const endpoints = this.db.prepare(`SELECT id, kind, canonical_target_id
        FROM completion_notification_targets WHERE id IN (${placeholders}) OR id = ?`)
        .all(...losers, survivorTargetId) as Array<{ id: number; kind: string; canonical_target_id: number | null }>;
      const survivor = endpoints.find((target) => target.id === survivorTargetId);
      const loserSet = new Set(losers);
      if (!survivor || survivor.kind !== 'app' || survivor.canonical_target_id !== null
        || endpoints.filter((target) => loserSet.has(target.id)).length !== losers.length
        || endpoints.some((target) => loserSet.has(target.id)
          && (target.kind !== 'app' || target.canonical_target_id !== null))) {
        throw new Error('duplicate merge requires canonical app targets');
      }
      if (!proveEquivalent()) throw new Error('duplicate merge equivalence proof failed');

      const verified = this.db.prepare(`SELECT id, kind, canonical_target_id
        FROM completion_notification_targets WHERE id IN (${placeholders}) OR id = ?`)
        .all(...losers, survivorTargetId) as Array<{ id: number; kind: string; canonical_target_id: number | null }>;
      const verifiedSurvivor = verified.find((target) => target.id === survivorTargetId);
      if (!verifiedSurvivor || verifiedSurvivor.kind !== 'app' || verifiedSurvivor.canonical_target_id !== null
        || verified.filter((target) => loserSet.has(target.id)).length !== losers.length
        || verified.some((target) => loserSet.has(target.id)
          && (target.kind !== 'app' || target.canonical_target_id !== null))) {
        throw new Error('duplicate merge endpoints changed during equivalence proof');
      }

      this.db.prepare(`INSERT INTO completion_notification_redirect_authorizations (loser_target_id, survivor_target_id)
        SELECT id, ? FROM completion_notification_targets
        WHERE canonical_target_id IN (${placeholders}) AND kind = 'app'
        ON CONFLICT(loser_target_id) DO UPDATE SET survivor_target_id = excluded.survivor_target_id`)
        .run(survivorTargetId, ...losers);
      this.db.prepare(`INSERT INTO completion_notification_redirect_authorizations (loser_target_id, survivor_target_id)
        VALUES ${losers.map(() => '(?, ?)').join(', ')}`)
        .run(...losers.flatMap((loser) => [loser, survivorTargetId]));

      this.db.prepare(`UPDATE completion_notification_aliases SET target_id = ?
        WHERE target_id IN (${placeholders})
           OR target_id IN (
             SELECT id FROM completion_notification_targets
             WHERE kind = 'external_generation' AND canonical_target_id IN (${placeholders})
           )`).run(survivorTargetId, ...losers, ...losers);
      this.db.prepare(`INSERT INTO completion_notification_watches (user_id, target_id)
        SELECT user_id, ? FROM completion_notification_watches
        WHERE target_id IN (${placeholders})
           OR target_id IN (
             SELECT id FROM completion_notification_targets
             WHERE kind = 'external_generation' AND canonical_target_id IN (${placeholders})
           )
        ON CONFLICT(user_id, target_id) DO NOTHING`).run(survivorTargetId, ...losers, ...losers);
      this.db.prepare(`DELETE FROM completion_notification_watches
        WHERE target_id IN (${placeholders})
           OR target_id IN (
             SELECT id FROM completion_notification_targets
             WHERE kind = 'external_generation' AND canonical_target_id IN (${placeholders})
           )`).run(...losers, ...losers);

      this.db.prepare(`UPDATE completion_notification_targets SET canonical_target_id = ?, updated_at = CURRENT_TIMESTAMP
        WHERE kind = 'external_generation' AND canonical_target_id IN (${placeholders})`)
        .run(survivorTargetId, ...losers);
      this.db.prepare(`UPDATE completion_notification_targets SET canonical_target_id = ?, updated_at = CURRENT_TIMESTAMP
        WHERE canonical_target_id IN (${placeholders})`).run(survivorTargetId, ...losers);
      this.db.prepare(`UPDATE completion_notification_targets SET canonical_target_id = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id IN (${placeholders})`).run(survivorTargetId, ...losers);
      this.db.prepare(`UPDATE completion_notification_targets
        SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(survivorTargetId);
      return this.resolveTarget(survivorTargetId)!;
    })();
  }

  mappingState(matchCount: number, activeCount: number): CompletionNotificationMappingState {
    if (activeCount > 1) return 'ambiguous_active';
    if (activeCount === 1) return 'one_active';
    return matchCount > 0 ? 'inactive_match' : 'none';
  }
}

export const completionNotificationTargetsDb = new CompletionNotificationTargetsRepository();
