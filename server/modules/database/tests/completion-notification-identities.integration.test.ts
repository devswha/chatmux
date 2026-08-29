import assert from 'node:assert/strict';
import test from 'node:test';

import type { ExternalCliSession } from '@/modules/providers/index.js';
import { CompletionNotificationOutboxRepository } from '@/modules/database/repositories/completion-notification-outbox.js';
import { CompletionNotificationTargetsRepository } from '@/modules/database/repositories/completion-notification-targets.js';
import {
  completionAppIdentityKey,
  completionExternalGenerationIdentityFromSession,
  completionExternalGenerationIdentityKey,
} from '@/modules/database/services/completion-target-identity.service.js';
import {
  addSubscription,
  addUser,
  appDecision,
  enablePush,
  get,
  payload,
  withDatabase,
} from '@/modules/database/tests/support/completion-notification-test-support.js';

test('application decisions require active watched targets and retain exact byte identity', () => {
  withDatabase((db) => {
    addUser(db, 1); addSubscription(db, 1); enablePush(db, 1);
    db.prepare(`INSERT INTO user_notification_preferences (user_id, preferences_json) VALUES (1, ?)`)
      .run(JSON.stringify({ channels: { webPush: true }, events: { stop: true } }));
    db.prepare("INSERT INTO projects (project_id, project_path) VALUES ('project', '/project')").run();
    db.prepare("INSERT INTO sessions (session_id, provider, project_path) VALUES ('session-1', 'claude', '/project')").run();
    const composed = 'é'; const decomposed = 'e\u0301';
    assert.notEqual(completionAppIdentityKey({ provider: 'claude', sessionId: composed }), completionAppIdentityKey({ provider: 'claude', sessionId: decomposed }));
    assert.throws(() => completionAppIdentityKey({ provider: 'claude', sessionId: '\ud800' }), /unpaired surrogate/);
    const cursorSession: ExternalCliSession = {
      kind: 'cursor',
      tmuxName: 'cursor-session',
      tmux: { socketPath: 'socket', sessionId: 's', windowId: 'w', paneId: 'p' },
    };
    assert.equal(completionExternalGenerationIdentityFromSession(cursorSession), null);
    const incompleteClaudeSession: ExternalCliSession = {
      kind: 'claude',
      tmuxName: 'claude-session',
      tmux: { socketPath: 'socket', sessionId: 's', windowId: 'w', paneId: 'p' },
      startedAtMs: 1,
    };
    assert.throws(
      () => completionExternalGenerationIdentityFromSession(incompleteClaudeSession),
      /agentPid/,
    );
    assert.throws(() => completionExternalGenerationIdentityKey({ provider: 'claude', socketPath: '\ud800', sessionId: 's', windowId: 'w', paneId: 'p', agentPid: 1, startedAtMs: 1 }), /unpaired surrogate/);
    assert.doesNotThrow(() => completionAppIdentityKey({ provider: 'claude', sessionId: 'session-\ud83d\ude80' }));
    const targets = new CompletionNotificationTargetsRepository(db);
    const identity = completionAppIdentityKey({ provider: 'claude', sessionId: 'session-1' });
    const app = targets.createTarget(identity, 'app', ['app']);
    const outbox = new CompletionNotificationOutboxRepository(db);
    assert.deepEqual(outbox.createApplicationDecision({
      ...appDecision(1, identity),
      eventOccurrenceKey: 'unwatched',
    }), []);
    assert.deepEqual(get<{ decisions: number; deliveries: number }>(db, `
      SELECT
        (SELECT COUNT(*) FROM completion_notification_outbox) AS decisions,
        (SELECT COUNT(*) FROM completion_notification_deliveries) AS deliveries
    `), { decisions: 0, deliveries: 0 });
    db.prepare('INSERT INTO completion_notification_watches (user_id, target_id) VALUES (1, ?)').run(app.id);
    const created = outbox.createApplicationDecision(appDecision(1, identity));
    assert.equal(created.length, 1);
    assert.deepEqual(outbox.createApplicationDecision(appDecision(1, identity)), created);
    assert.equal(outbox.createApplicationDecision({
      ...appDecision(1, identity),
      preferenceClass: 'liveStop',
      eventOccurrenceKey: 'live-stop',
    }).length, 1);
    db.prepare(`UPDATE user_notification_preferences
      SET preferences_json = ? WHERE user_id = 1`)
      .run(JSON.stringify({ channels: { webPush: true }, events: { stop: false, liveStop: true } }));
    assert.deepEqual(outbox.createApplicationDecision({
      ...appDecision(1, identity),
      eventOccurrenceKey: 'stop-disabled',
    }), []);
    db.prepare("UPDATE user_notification_preferences SET preferences_json = '{corrupt' WHERE user_id = 1").run();
    assert.throws(() => outbox.createApplicationDecision({
      ...appDecision(1, identity), eventOccurrenceKey: 'corrupt-preferences',
    }), /malformed JSON/);
    assert.throws(() => outbox.createApplicationDecision({
      ...appDecision(1, identity), provider: 'codex', eventOccurrenceKey: 'mismatch',
    }), /does not match/);
  });
});
test('promotion replays watched generations and merge retargets every loser only with authorization', () => {
  withDatabase((db) => {
    addUser(db, 1);
    const targets = new CompletionNotificationTargetsRepository(db);
    const survivor = targets.createTarget('survivor', 'app', ['survivor']);
    const loserOne = targets.createTarget('loser-one', 'app', ['loser-one']);
    const loserTwo = targets.createTarget('loser-two', 'app', ['loser-two']);
    const generation = targets.createTarget('generation', 'external_generation', ['generation']);
    db.prepare('INSERT INTO completion_notification_watches (user_id, target_id) VALUES (1, ?)').run(generation.id);

    targets.promoteGenerationToApp('generation', 'loser-one');
    assert.equal(targets.getWatch(1, loserOne.id), true);
    assert.equal(targets.resolveAlias('generation')?.id, loserOne.id);
    assert.equal(targets.promoteGenerationToApp('generation', 'loser-one').id, loserOne.id);
    assert.equal(targets.getWatch(1, loserOne.id), true);
    assert.throws(
      () => db.prepare('UPDATE completion_notification_targets SET canonical_target_id = ? WHERE id = ?')
        .run(survivor.id, loserOne.id),
      /authorization/,
    );

    assert.throws(() => targets.mergeEquivalentApps([loserOne.id, loserTwo.id], survivor.id, () => false), /proof failed/);
    assert.equal(targets.resolveAlias('loser-one')?.id, loserOne.id);
    assert.equal(get<{ count: number }>(db, 'SELECT COUNT(*) AS count FROM completion_notification_redirect_authorizations')?.count, 0);

    targets.mergeEquivalentApps([loserOne.id, loserTwo.id], survivor.id, () => true);
    assert.equal(targets.resolveAlias('loser-one')?.id, survivor.id);
    assert.equal(targets.resolveAlias('generation')?.id, survivor.id);
    assert.equal(targets.resolveTarget(loserOne.id)?.id, survivor.id);
    assert.equal(targets.resolveTarget(loserTwo.id)?.id, survivor.id);
    assert.equal(targets.resolveTarget(generation.id)?.id, survivor.id);
    assert.equal(targets.getWatch(1, survivor.id), true);
    assert.equal(get<{ count: number }>(db, 'SELECT COUNT(*) AS count FROM completion_notification_redirect_authorizations')?.count, 0);
  });
});

test('target resolution rejects corrupt redirects instead of traversing them', () => {
  withDatabase((db) => {
    const targets = new CompletionNotificationTargetsRepository(db);
    const first = targets.createTarget('first', 'app');
    const second = targets.createTarget('second', 'app');
    const generation = targets.createTarget('generation', 'external_generation');
    db.exec('DROP TRIGGER completion_notification_targets_validate_redirect');
    db.exec('PRAGMA foreign_keys = OFF');

    db.prepare('UPDATE completion_notification_targets SET canonical_target_id = ? WHERE id = ?')
      .run(second.id, first.id);
    assert.equal(targets.resolveTarget(first.id)?.id, second.id);

    db.prepare('UPDATE completion_notification_targets SET canonical_target_id = ? WHERE id = ?')
      .run(generation.id, second.id);
    assert.throws(() => targets.resolveTarget(first.id), /redirect invariant/);

    db.prepare('UPDATE completion_notification_targets SET canonical_target_id = ? WHERE id = ?')
      .run(first.id, second.id);
    assert.throws(() => targets.resolveTarget(first.id), /redirect invariant/);

    db.prepare('UPDATE completion_notification_targets SET canonical_target_id = NULL WHERE id = ?').run(second.id);
    db.prepare('UPDATE completion_notification_targets SET canonical_target_id = ? WHERE id = ?')
      .run(generation.id, first.id);
    assert.throws(() => targets.resolveTarget(first.id), /redirect invariant/);

    db.prepare('UPDATE completion_notification_targets SET canonical_target_id = 999 WHERE id = ?').run(first.id);
    assert.throws(() => targets.resolveTarget(first.id), /redirect invariant/);
  });
});
test('outbox entry points fail closed on corrupt redirects', () => {
  withDatabase((db) => {
    addUser(db, 1); addSubscription(db, 1); enablePush(db, 1);
    db.prepare(`INSERT INTO user_notification_preferences (user_id, preferences_json) VALUES (1, ?)`)
      .run(JSON.stringify({ channels: { webPush: true }, events: { stop: true } }));
    db.prepare("INSERT INTO projects (project_id, project_path) VALUES ('project', '/project')").run();
    db.prepare("INSERT INTO sessions (session_id, provider, project_path) VALUES ('session-1', 'claude', '/project')").run();
    const targets = new CompletionNotificationTargetsRepository(db);
    const identity = completionAppIdentityKey({ provider: 'claude', sessionId: 'session-1' });
    const app = targets.createTarget(identity, 'app');
    const generation = targets.createTarget('generation', 'external_generation');
    targets.promoteGenerationToApp('generation', identity);
    db.prepare('INSERT INTO completion_notification_watches (user_id, target_id) VALUES (1, ?)').run(app.id);
    targets.observeGeneration(generation.id, 'running', 'running');
    db.exec('DROP TRIGGER completion_notification_targets_validate_redirect');
    db.exec('PRAGMA foreign_keys = OFF');
    db.prepare('UPDATE completion_notification_targets SET canonical_target_id = ? WHERE id = ?')
      .run(generation.id, app.id);

    const outbox = new CompletionNotificationOutboxRepository(db);
    assert.throws(() => outbox.createTerminalDecision({
      generationTargetId: generation.id, evidenceCursor: 'done', eventCode: 'reply_ready',
      targetAliasSnapshot: 'generation', payload, now: 100,
    }), /redirect invariant/);
    assert.throws(() => outbox.createApplicationDecision(appDecision(1, identity)), /redirect invariant/);
  });
});

