import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getDatabasePath } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { sessionsDb } from '@/modules/database/repositories/sessions.db.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'sessions-db-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('session repository reads all sessions, project sessions, pages, and counts', async () => {
  await withIsolatedDatabase(() => {
    const projectPath = '/workspace/demo-project';
    sessionsDb.createSession('session-early', 'claude', projectPath, 'Early Session', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    sessionsDb.createSession('session-middle', 'claude', projectPath, 'Middle Session', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z');
    sessionsDb.createSession('session-late', 'claude', projectPath, 'Late Session', '2026-01-03T00:00:00.000Z', '2026-01-03T00:00:00.000Z');
    sessionsDb.createSession('session-other', 'claude', '/workspace/other-project', 'Other Session');

    const allSessions = sessionsDb.getAllSessions();
    const projectSessions = sessionsDb.getSessionsByProjectPath(projectPath);
    const page = sessionsDb.getSessionsByProjectPathPage(projectPath, 1, 1);

    assert.deepEqual(
      allSessions.map((session) => session.session_id).sort(),
      ['session-early', 'session-late', 'session-middle', 'session-other'],
    );
    assert.deepEqual(
      projectSessions.map((session) => session.session_id).sort(),
      ['session-early', 'session-late', 'session-middle'],
    );
    assert.deepEqual(page.map((session) => session.session_id), ['session-middle']);
    assert.equal(sessionsDb.countSessionsByProjectPath(projectPath), 3);
  });
});

test('createSession refreshes an existing session', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createSession('session-reused', 'claude', '/workspace/demo-project', 'First Name');
    sessionsDb.createSession('session-reused', 'claude', '/workspace/demo-project', 'Updated Name');

    const refreshedSession = sessionsDb.getSessionById('session-reused');

    assert.equal(sessionsDb.getAllSessions().length, 1);
    assert.equal(refreshedSession?.custom_name, 'Updated Name');
  });
});

test('repository reads normalize SQLite UTC timestamps to ISO strings', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('session-timezone', 'claude', '/workspace/demo-project');

    const row = sessionsDb.getSessionById('session-timezone');
    assert.ok(row?.created_at.endsWith('Z'));
    assert.ok(row?.updated_at.endsWith('Z'));
    assert.match(row?.created_at ?? '', /^\d{4}-\d{2}-\d{2}T/);
    assert.match(row?.updated_at ?? '', /^\d{4}-\d{2}-\d{2}T/);
  });
});
test('sessionsDb uses the explicit DATABASE_PATH override', async () => {
  await withIsolatedDatabase(() => {
    assert.equal(getDatabasePath(), process.env.DATABASE_PATH);

    sessionsDb.createSession('explicit-path', 'claude', '/workspace/demo-project', 'Explicit Path');

    assert.equal(sessionsDb.getSessionById('explicit-path')?.custom_name, 'Explicit Path');
  });
});

test('session repository lists the newest sessions across projects and counts them all', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createSession('session-early', 'claude', '/workspace/a', 'Early', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    sessionsDb.createSession('session-middle', 'codex', '/workspace/b', 'Middle', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z');
    sessionsDb.createSession('session-late', 'claude', '/workspace/a', 'Late', '2026-01-03T00:00:00.000Z', '2026-01-03T00:00:00.000Z');

    assert.deepEqual(sessionsDb.getRecentSessions(2).map((session) => session.session_id), ['session-late', 'session-middle']);
    assert.deepEqual(sessionsDb.getRecentSessions(0), []);
    assert.equal(sessionsDb.countSessions(), 3);
  });
});
