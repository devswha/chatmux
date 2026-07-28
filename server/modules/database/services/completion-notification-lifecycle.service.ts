import type Database from 'better-sqlite3';

import { completionAppIdentityKey } from './completion-target-identity.service.js';

const MAX_SESSIONS_PER_REVOCATION = 500;

type SessionIdentity = { sessionId: string; provider: string };

/**
 * Revokes notification ownership for the supplied app sessions. Call inside the
 * same transaction that archives or deletes those sessions/projects.
 */
export function revokeCompletionNotificationsForSessions(
  db: Database.Database,
  sessions: ReadonlyArray<SessionIdentity>,
): void {
  for (let start = 0; start < sessions.length; start += MAX_SESSIONS_PER_REVOCATION) {
    const identityKeys = sessions
      .slice(start, start + MAX_SESSIONS_PER_REVOCATION)
      .map(({ sessionId, provider }) => completionAppIdentityKey({ provider, sessionId }));
    const placeholders = identityKeys.map(() => '?').join(', ');
    const targets = `
      SELECT DISTINCT CASE
        WHEN canonical_target_id IS NULL THEN id
        ELSE canonical_target_id
      END AS id
      FROM completion_notification_targets
      WHERE kind = 'app' AND identity_key IN (${placeholders})
    `;

    db.prepare(`UPDATE completion_notification_targets
      SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP
      WHERE id IN (${targets})`).run(...identityKeys);
    db.prepare(`DELETE FROM completion_notification_watches
      WHERE target_id IN (${targets})`).run(...identityKeys);
    db.prepare(`UPDATE completion_notification_deliveries
      SET state = 'permanent_failed', claim_token = NULL, claim_expires_at = NULL,
          error_class = 'lifecycle_revoked', updated_at = CURRENT_TIMESTAMP
      WHERE state IN ('pending', 'claimed', 'transient_retry', 'paused_global')
        AND outbox_id IN (
          SELECT outbox.id
          FROM completion_notification_outbox outbox
          WHERE outbox.canonical_target_id IN (${targets})
             OR outbox.canonical_target_id IN (
               SELECT id
               FROM completion_notification_targets
               WHERE canonical_target_id IN (${targets})
             )
        )`).run(...identityKeys, ...identityKeys);
  }
}

export function revokeCompletionNotificationsForProject(
  db: Database.Database,
  projectPath: string,
): void {
  const sessions = db.prepare('SELECT session_id, provider FROM sessions WHERE project_path = ?')
    .all(projectPath) as Array<{ session_id: string; provider: string }>;
  revokeCompletionNotificationsForSessions(db, sessions.map(({ session_id, provider }) => ({
    sessionId: session_id,
    provider,
  })));
}

export function revokeCompletionNotificationsForSession(
  db: Database.Database,
  sessionId: string,
): void {
  const sessions = db.prepare('SELECT session_id, provider FROM sessions WHERE session_id = ?')
    .all(sessionId) as Array<{ session_id: string; provider: string }>;
  revokeCompletionNotificationsForSessions(db, sessions.map(({ session_id, provider }) => ({
    sessionId: session_id,
    provider,
  })));
}
