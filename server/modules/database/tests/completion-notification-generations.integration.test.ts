import assert from 'node:assert/strict';
import test from 'node:test';

import { CompletionNotificationTargetsRepository } from '@/modules/database/repositories/completion-notification-targets.js';
import { completionExternalGenerationPaneEvidenceKey } from '@/modules/database/services/completion-target-identity.service.js';
import {
  addUser,
  enablePush,
  get,
  type Row,
  withDatabase,
} from '@/modules/database/tests/support/completion-notification-test-support.js';

test('generation observations establish baselines, arm turns, replay evidence, and survive restart', () => {
  withDatabase((db) => {
    const targets = new CompletionNotificationTargetsRepository(db);
    const generation = targets.createTarget('generation', 'external_generation');
    assert.deepEqual(targets.observeGeneration(generation.id, 'none', 'unavailable'), { state: 'unobserved', sequence: null, replay: true, stateRevision: 0 });
    assert.deepEqual(targets.observeGeneration(generation.id, 'baseline-terminal', 'failed'), { state: 'terminal', sequence: null, replay: false, stateRevision: 1 });
    const armed = targets.observeGeneration(generation.id, 'turn-1-running', 'running');
    assert.deepEqual(armed, { state: 'running', sequence: 1, replay: false, stateRevision: 2 });
    assert.deepEqual(targets.observeGeneration(generation.id, 'unavailable-running', 'unavailable'), { ...armed, replay: true });
    assert.deepEqual(targets.observeGeneration(generation.id, 'turn-1-running', 'asking'), { ...armed, replay: true });
    assert.deepEqual(targets.observeGeneration(generation.id, 'turn-1-done', 'failed'), { state: 'terminal', sequence: null, replay: false, stateRevision: 3 });
    const afterRestart = new CompletionNotificationTargetsRepository(db).observeGeneration(generation.id, 'turn-2-running', 'running');
    assert.deepEqual(afterRestart, { state: 'running', sequence: 2, replay: false, stateRevision: 4 });
    assert.deepEqual(targets.observeGeneration(generation.id, 'turn-2-done', 'unknown'), { state: 'terminal', sequence: null, replay: false, stateRevision: 5 });
    assert.deepEqual(targets.observeGeneration(generation.id, 'unavailable-terminal', 'unavailable'), { state: 'terminal', sequence: null, replay: true, stateRevision: 5 });
    assert.equal(targets.pruneStaleGenerationCandidates(1_000, []), 0);
    assert.equal(targets.generationCount(), 1);
  });
});
test('generation prune evidence is exact, strict, fail-closed, and preserves immutable outbox rows', () => {
  withDatabase((db) => {
    const targets = new CompletionNotificationTargetsRepository(db);
    const cutoff = 30 * 24 * 60 * 60 * 1_000;
    const paneEvidenceKey = completionExternalGenerationPaneEvidenceKey({
      socketPath: '/tmp/socket\u0000exact',
      sessionId: 'session',
      windowId: 'window',
      paneId: 'pane',
    });
    assert.equal(paneEvidenceKey, completionExternalGenerationPaneEvidenceKey({
      socketPath: '/tmp/socket\u0000exact',
      sessionId: 'session',
      windowId: 'window',
      paneId: 'pane',
    }));
    assert.notEqual(paneEvidenceKey, completionExternalGenerationPaneEvidenceKey({
      socketPath: '/tmp/socket\u0000exact-session',
      sessionId: 'session',
      windowId: 'window',
      paneId: 'pane',
    }));

    const equality = targets.createTarget('generation-equality', 'external_generation');
    const eligible = targets.createTarget('generation-eligible', 'external_generation');
    const incomplete = targets.createTarget('generation-incomplete', 'external_generation');
    targets.touchObservedGenerations([{ generationTargetId: equality.id, paneEvidenceKey }], cutoff);
    targets.touchObservedGenerations([{ generationTargetId: eligible.id, paneEvidenceKey }], cutoff - 1);
    targets.observeGeneration(incomplete.id, 'terminal', 'failed');

    assert.deepEqual(targets.listStaleGenerationCandidates(cutoff), [{
      generationTargetId: eligible.id,
      paneEvidenceKey,
      lastSeenAt: cutoff - 1,
    }]);
    assert.equal(targets.pruneStaleGenerationCandidates(cutoff, []), 0, 'repository never bulk-prunes stale rows');
    assert.equal(targets.generationCount(), 3);

    targets.touchObservedGenerations([{ generationTargetId: eligible.id, paneEvidenceKey }], cutoff + 1);
    assert.equal(targets.pruneStaleGenerationCandidates(cutoff, [eligible.id]), 0);
    assert.equal(targets.pruneStaleGenerationCandidates(cutoff, [equality.id]), 0, 'cutoff equality is retained');
    assert.equal(targets.generationCount(), 3);

    addUser(db, 1);
    db.prepare('INSERT INTO completion_notification_watches (user_id, target_id) VALUES (1, ?)')
      .run(eligible.id);
    db.prepare(`INSERT INTO completion_notification_outbox
      (decision_id, decision_key, user_id, event_code, canonical_target_id, target_alias_snapshot, payload_json, notification_tag)
      VALUES ('prune-decision', 'prune-key', 1, 'reply_ready', ?, 'eligible', '{}', 'tag')`).run(eligible.id);
    targets.touchObservedGenerations([{ generationTargetId: eligible.id, paneEvidenceKey }], cutoff - 1);
    assert.equal(get<{ count: number }>(db, 'SELECT count(*) AS count FROM completion_notification_watches WHERE target_id = ?', eligible.id)?.count, 1);
    assert.equal(targets.pruneStaleGenerationCandidates(cutoff, [eligible.id]), 1);

    assert.equal(targets.generationCount(), 2);
    assert.equal(get<Row>(db, 'SELECT * FROM completion_notification_generation_state WHERE generation_target_id = ?', eligible.id), undefined);
    assert.equal(get<{ count: number }>(db, 'SELECT count(*) AS count FROM completion_notification_watches WHERE target_id = ?', eligible.id)?.count, 0);
    assert.deepEqual(get<Row>(db, "SELECT decision_id, canonical_target_id FROM completion_notification_outbox WHERE decision_id = 'prune-decision'"),
      { decision_id: 'prune-decision', canonical_target_id: null });
    assert.equal(targets.listStaleGenerationCandidates(cutoff).length, 0);
    assert.notEqual(get<Row>(db, 'SELECT * FROM completion_notification_generation_state WHERE generation_target_id = ?', incomplete.id), undefined);
  });
});

test('watch mutations are idempotent with CAS conflicts and global pause state', () => {
  withDatabase((db) => {
    addUser(db, 1);
    const targets = new CompletionNotificationTargetsRepository(db);
    const app = targets.createTarget('app', 'app', ['alias']);
    const mutation = { mutationId: 'same', alias: 'alias', expectedRevision: 1, watched: true };
    const first = targets.setWatch(1, mutation);
    assert.deepEqual(targets.setWatch(1, mutation), first);
    assert.deepEqual(targets.setWatch(1, { ...mutation, watched: false }), { ok: false, reason: 'mutation_replay_conflict' });
    assert.deepEqual(targets.setWatch(1, { mutationId: 'stale', alias: 'alias', expectedRevision: 1, watched: false }), {
      ok: false,
      reason: 'revision_conflict',
      target: { alias: 'alias', kind: 'app', revision: 2, watched: true },
    });
    assert.equal(first.ok && first.globalPaused, true);
    const sameState = targets.setWatch(1, { mutationId: 'same-state', alias: 'alias', expectedRevision: 2, watched: true });
    assert.equal(sameState.ok && sameState.target.revision, 2);
    assert.deepEqual(targets.setWatch(1, { mutationId: 'same-state', alias: 'alias', expectedRevision: 2, watched: true }), sameState);
    enablePush(db, 1);
    const next = targets.setWatch(1, { mutationId: 'off', alias: 'alias', expectedRevision: 2, watched: false });
    assert.equal(next.ok && next.globalPaused, false);
    assert.equal(targets.getWatch(1, app.id), false);
  });
});

