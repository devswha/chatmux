import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { completionNotificationOutboxDb } from '@/modules/database/repositories/completion-notification-outbox.js';
import { completionNotificationTargetsDb } from '@/modules/database/repositories/completion-notification-targets.js';
import { projectsDb } from '@/modules/database/repositories/projects.db.js';
import { sessionsDb } from '@/modules/database/repositories/sessions.db.js';
import {
  completionAppAlias,
  completionAppIdentityKey,
} from '@/modules/database/services/completion-target-identity.service.js';
import { resolveCompletionTargetsFromDetailedScan } from '@/modules/notifications/index.js';

async function withIsolatedDatabase(run: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(tmpdir(), 'completion-lifecycle-'));
  process.env.DATABASE_PATH = path.join(directory, 'auth.db');
  closeConnection();
  await initializeDatabase();
  try {
    await run();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(directory, { recursive: true, force: true });
  }
}

function enqueue(sessionId: string, provider: string): number {
  const db = getConnection();
  const identity = { sessionId, provider };
  const target = completionNotificationTargetsDb.createTarget(
    completionAppIdentityKey(identity), 'app', [completionAppAlias(identity)],
  );
  db.prepare("INSERT INTO users (id, username, password_hash) VALUES (1, 'owner', 'hash')").run();
  db.prepare('UPDATE completion_notification_policy SET desired_web_push = 1 WHERE user_id = 1').run();
  db.prepare("INSERT INTO push_subscriptions (user_id, endpoint, keys_p256dh, keys_auth) VALUES (1, 'https://push/owner', 'key', 'auth')").run();
  db.prepare(`INSERT INTO completion_notification_watches (user_id, target_id) VALUES (1, ?)`)
    .run(target.id);
  db.prepare(`INSERT INTO completion_notification_outbox
    (decision_id, decision_key, user_id, event_code, canonical_target_id, target_alias_snapshot, payload_json, notification_tag)
    VALUES (?, ?, 1, 'reply_ready', ?, 'alias', '{}', 'tag')`)
    .run(`decision-${sessionId}`, `key-${sessionId}`, target.id);
  const outboxId = (db.prepare('SELECT id FROM completion_notification_outbox WHERE decision_id = ?')
    .get(`decision-${sessionId}`) as { id: number }).id;
  db.prepare(`INSERT INTO completion_notification_deliveries
    (outbox_id, subscription_id, subscription_id_at_creation, endpoint_owner_id, endpoint_snapshot, next_due_at)
    VALUES (?, 1, 1, 1, 'https://push/owner', 0)`).run(outboxId);
  return (db.prepare('SELECT id FROM completion_notification_deliveries WHERE outbox_id = ?')
    .get(outboxId) as { id: number }).id;
}
function createUnwatchedRedirectedAppTarget(identity: { sessionId: string; provider: string }) {
  const db = getConnection();
  db.prepare("INSERT INTO users (id, username, password_hash) VALUES (1, 'owner', 'hash')").run();
  const redirected = completionNotificationTargetsDb.createTarget(
    completionAppIdentityKey(identity), 'app', [completionAppAlias(identity)],
  );
  const canonical = completionNotificationTargetsDb.createTarget(
    `app:canonical:${identity.provider}:${identity.sessionId}`, 'app',
  );
  completionNotificationTargetsDb.mergeEquivalentApps([redirected.id], canonical.id, () => true);
  return completionNotificationTargetsDb.resolveAlias(completionAppAlias(identity))!;
}

test('project deletion invalidates an unwatched redirected app target', async () => {
  await withIsolatedDatabase(() => {
    const identity = { sessionId: 'unwatched-project-delete', provider: 'claude' };
    sessionsDb.createSession(identity.sessionId, identity.provider, '/workspace/unwatched-project-delete');
    const app = createUnwatchedRedirectedAppTarget(identity);
    const staleRevision = app.revision;

    assert.equal(completionNotificationTargetsDb.getWatch(1, app.id), false);
    projectsDb.deleteProjectPath('/workspace/unwatched-project-delete');

    const updated = completionNotificationTargetsDb.resolveAlias(completionAppAlias(identity));
    assert.equal(updated?.id, app.id);
    assert.equal(updated?.revision, staleRevision + 1);
    assert.deepEqual(completionNotificationTargetsDb.setWatch(1, {
      mutationId: 'stale-enable-after-unwatched-project-delete',
      alias: completionAppAlias(identity),
      expectedRevision: staleRevision,
      watched: true,
    }), {
      ok: false,
      reason: 'revision_conflict',
      target: {
        alias: completionAppAlias(identity),
        kind: 'app',
        revision: staleRevision + 1,
        watched: false,
      },
    });
  });
});

test('session deletion invalidates an unwatched redirected app target', async () => {
  await withIsolatedDatabase(() => {
    const identity = { sessionId: 'unwatched-session-delete', provider: 'claude' };
    sessionsDb.createSession(identity.sessionId, identity.provider, '/workspace/unwatched-session-delete');
    const app = createUnwatchedRedirectedAppTarget(identity);
    const staleRevision = app.revision;

    assert.equal(completionNotificationTargetsDb.getWatch(1, app.id), false);
    assert.equal(sessionsDb.deleteSessionById(identity.sessionId), true);

    const updated = completionNotificationTargetsDb.resolveAlias(completionAppAlias(identity));
    assert.equal(updated?.id, app.id);
    assert.equal(updated?.revision, staleRevision + 1);
    assert.deepEqual(completionNotificationTargetsDb.setWatch(1, {
      mutationId: 'stale-enable-after-unwatched-session-delete',
      alias: completionAppAlias(identity),
      expectedRevision: staleRevision,
      watched: true,
    }), {
      ok: false,
      reason: 'revision_conflict',
      target: {
        alias: completionAppAlias(identity),
        kind: 'app',
        revision: staleRevision + 1,
        watched: false,
      },
    });
  });
});

test('project deletion atomically revokes app intent and invalidates stale enables', async () => {
  await withIsolatedDatabase(() => {
    const identity = { sessionId: 'delete-session', provider: 'claude' };
    sessionsDb.createSession(identity.sessionId, identity.provider, '/workspace/lifecycle-delete');
    const deliveryId = enqueue(identity.sessionId, identity.provider);

    projectsDb.deleteProjectPath('/workspace/lifecycle-delete');

    const db = getConnection();
    const app = completionNotificationTargetsDb.resolveAlias(completionAppAlias(identity));
    assert.equal(app?.revision, 2);
    assert.equal(completionNotificationTargetsDb.getWatch(1, app!.id), false);
    assert.deepEqual(completionNotificationTargetsDb.setWatch(1, {
      mutationId: 'stale-enable-after-project-delete',
      alias: completionAppAlias(identity),
      expectedRevision: 1,
      watched: true,
    }), {
      ok: false,
      reason: 'revision_conflict',
      target: {
        alias: completionAppAlias(identity),
        kind: 'app',
        revision: 2,
        watched: false,
      },
    });
    assert.deepEqual(db.prepare('SELECT state, error_class FROM completion_notification_deliveries WHERE id = ?')
      .get(deliveryId), { state: 'permanent_failed', error_class: 'lifecycle_revoked' });
    assert.equal(completionNotificationOutboxDb.claimDue(0).length, 0);
  });
});

test('project deletion permanently closes paused deliveries after global re-enable', async () => {
  await withIsolatedDatabase(() => {
    const identity = { sessionId: 'paused-project-delete', provider: 'claude' };
    sessionsDb.createSession(identity.sessionId, identity.provider, '/workspace/paused-project-delete');
    const deliveryId = enqueue(identity.sessionId, identity.provider);
    const db = getConnection();

    db.prepare('UPDATE completion_notification_policy SET desired_web_push = 0 WHERE user_id = 1').run();
    db.prepare(`UPDATE completion_notification_deliveries
      SET state = 'paused_global', claim_token = NULL, claim_expires_at = NULL
      WHERE id = ?`).run(deliveryId);

    projectsDb.deleteProjectPath('/workspace/paused-project-delete');
    db.prepare('UPDATE completion_notification_policy SET desired_web_push = 1 WHERE user_id = 1').run();

    assert.deepEqual(db.prepare('SELECT state, error_class FROM completion_notification_deliveries WHERE id = ?')
      .get(deliveryId), { state: 'permanent_failed', error_class: 'lifecycle_revoked' });
    assert.equal(completionNotificationOutboxDb.claimDue(0).length, 0);
  });
});

test('project deletion closes immutable outbox deliveries redirected to a survivor target', async () => {
  await withIsolatedDatabase(() => {
    const identity = { sessionId: 'redirected-project-delete', provider: 'claude' };
    sessionsDb.createSession(identity.sessionId, identity.provider, '/workspace/redirected-project-delete');
    const deliveryId = enqueue(identity.sessionId, identity.provider);
    const db = getConnection();
    const loser = completionNotificationTargetsDb.resolveAlias(completionAppAlias(identity))!;
    const survivor = completionNotificationTargetsDb.createTarget(
      'app:survivor:claude:redirected-project-delete', 'app',
    );
    completionNotificationTargetsDb.mergeEquivalentApps([loser.id], survivor.id, () => true);

    projectsDb.deleteProjectPath('/workspace/redirected-project-delete');

    assert.deepEqual(db.prepare(`SELECT canonical_target_id FROM completion_notification_outbox
      WHERE id = (SELECT outbox_id FROM completion_notification_deliveries WHERE id = ?)`)
      .get(deliveryId), { canonical_target_id: loser.id });
    assert.deepEqual(db.prepare('SELECT state, error_class FROM completion_notification_deliveries WHERE id = ?')
      .get(deliveryId), { state: 'permanent_failed', error_class: 'lifecycle_revoked' });
  });
});

test('session delete closes immutable outbox deliveries redirected to a survivor target', async () => {
  await withIsolatedDatabase(() => {
    const identity = { sessionId: 'redirected-session-delete', provider: 'claude' };
    sessionsDb.createSession(identity.sessionId, identity.provider, '/workspace/redirected-session-delete');
    const deliveryId = enqueue(identity.sessionId, identity.provider);
    const db = getConnection();
    const loser = completionNotificationTargetsDb.resolveAlias(completionAppAlias(identity))!;
    const survivor = completionNotificationTargetsDb.createTarget(
      'app:survivor:claude:redirected-session-delete', 'app',
    );
    completionNotificationTargetsDb.mergeEquivalentApps([loser.id], survivor.id, () => true);

    assert.equal(sessionsDb.deleteSessionById(identity.sessionId), true);

    assert.deepEqual(db.prepare(`SELECT canonical_target_id FROM completion_notification_outbox
      WHERE id = (SELECT outbox_id FROM completion_notification_deliveries WHERE id = ?)`)
      .get(deliveryId), { canonical_target_id: loser.id });
    assert.deepEqual(db.prepare('SELECT state, error_class FROM completion_notification_deliveries WHERE id = ?')
      .get(deliveryId), { state: 'permanent_failed', error_class: 'lifecycle_revoked' });
  });
});
test('session deletion revokes app intent, preserves generation watches, and invalidates stale enables', async () => {
  await withIsolatedDatabase(() => {
    const identity = { sessionId: 'session-delete', provider: 'claude' };
    sessionsDb.createSession(identity.sessionId, identity.provider, '/workspace/session-delete');
    const deliveryId = enqueue(identity.sessionId, identity.provider);
    const db = getConnection();
    const generation = completionNotificationTargetsDb.createTarget('generation:session-delete', 'external_generation');
    db.prepare('INSERT INTO completion_notification_watches (user_id, target_id) VALUES (1, ?)').run(generation.id);

    assert.equal(sessionsDb.deleteSessionById(identity.sessionId), true);

    const app = completionNotificationTargetsDb.resolveAlias(completionAppAlias(identity));
    assert.equal(app?.revision, 2);
    assert.equal(completionNotificationTargetsDb.getWatch(1, app!.id), false);
    assert.equal(completionNotificationTargetsDb.getWatch(1, generation.id), true);
    assert.deepEqual(completionNotificationTargetsDb.setWatch(1, {
      mutationId: 'stale-enable-after-session-delete',
      alias: completionAppAlias(identity),
      expectedRevision: 1,
      watched: true,
    }), {
      ok: false,
      reason: 'revision_conflict',
      target: {
        alias: completionAppAlias(identity),
        kind: 'app',
        revision: 2,
        watched: false,
      },
    });
    assert.deepEqual(db.prepare('SELECT state, error_class FROM completion_notification_deliveries WHERE id = ?')
      .get(deliveryId), { state: 'permanent_failed', error_class: 'lifecycle_revoked' });
    assert.equal(completionNotificationOutboxDb.claimDue(0).length, 0);
  });
});

test('project delete atomically revokes watches and queued deliveries before claim', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createSession('project-delete', 'claude', '/workspace/project-delete');
    const deliveryId = enqueue('project-delete', 'claude');

    projectsDb.deleteProjectPath('/workspace/project-delete');

    const db = getConnection();
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM completion_notification_watches').get() as { count: number }).count, 0);
    assert.deepEqual(db.prepare('SELECT state, error_class FROM completion_notification_deliveries WHERE id = ?')
      .get(deliveryId), { state: 'permanent_failed', error_class: 'lifecycle_revoked' });
    assert.equal(completionNotificationOutboxDb.claimDue(0).length, 0);
  });
});

test('session delete atomically revokes watches and queued deliveries before claim', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createSession('delete-session', 'claude', '/workspace/lifecycle-delete');
    const deliveryId = enqueue('delete-session', 'claude');

    assert.equal(sessionsDb.deleteSessionById('delete-session'), true);

    const db = getConnection();
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM completion_notification_watches').get() as { count: number }).count, 0);
    assert.deepEqual(db.prepare('SELECT state, error_class FROM completion_notification_deliveries WHERE id = ?')
      .get(deliveryId), { state: 'permanent_failed', error_class: 'lifecycle_revoked' });
    assert.equal(completionNotificationOutboxDb.claimDue(0).length, 0);
  });
});

function detailedSession() {
  return {
    ok: true,
    sessions: [{
      kind: 'claude' as const,
      providerSessionId: 'resolver-session',
      tmuxName: 'resolver',
      tmux: { socketPath: '/tmp/tmux', sessionId: 'resolver', windowId: '@1', paneId: '%1' },
      agentPid: 1,
      startedAtMs: 1,
    }],
  };
}

test('resolver redacts identity keys from pre- and post-promotion identity conflicts', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createSession('resolver-session', 'claude', '/workspace/resolver', undefined, undefined, undefined, process.execPath);
    const repository = completionNotificationTargetsDb;
    const createTarget = repository.createTarget;
    repository.createTarget = ((identityKey: string, kind: 'app' | 'external_generation', aliases: string[] = []) => {
      if (kind === 'app') return { id: 901, kind: 'app', identity_key: 'wrong-pre', revision: 1 };
      return createTarget.call(repository, identityKey, kind, aliases);
    }) as typeof repository.createTarget;
    try {
      assert.throws(() => resolveCompletionTargetsFromDetailedScan(detailedSession(), 1),
        /completion_target_identity_conflict.*pre_promotion.*actualTargetId.*901.*actualKind.*app/);
      assert.throws(() => resolveCompletionTargetsFromDetailedScan(detailedSession(), 1),
        (error: Error) => !error.message.includes('wrong-pre')
          && !error.message.includes('completion-target/v1:'));
    } finally {
      repository.createTarget = createTarget;
    }

    const promote = repository.promoteGenerationToApp;
    repository.promoteGenerationToApp = ((() => ({
      id: 902, kind: 'app', identity_key: 'wrong-post', revision: 1,
    })) as typeof repository.promoteGenerationToApp);
    try {
      assert.throws(() => resolveCompletionTargetsFromDetailedScan(detailedSession(), 1),
        /completion_target_identity_conflict.*post_promotion.*actualTargetId.*902.*actualKind.*app/);
      assert.throws(() => resolveCompletionTargetsFromDetailedScan(detailedSession(), 1),
        (error: Error) => !error.message.includes('wrong-post')
          && !error.message.includes('completion-target/v1:'));
    } finally {
      repository.promoteGenerationToApp = promote;
    }
  });
});
