import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { closeConnection, getConnection, getDatabasePath } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { projectsDb } from '@/modules/database/repositories/projects.db.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'projects-db-'));
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

test('projectsDb.createProjectPath returns created for fresh paths', async () => {
  await withIsolatedDatabase(() => {
    const created = projectsDb.createProjectPath('/workspace/new-project');

    assert.equal(created.outcome, 'created');
    assert.ok(created.project);
    assert.equal(created.project?.project_path, '/workspace/new-project');
  });
});


test('projectsDb.createProjectPath returns active_conflict for active duplicates', async () => {
  await withIsolatedDatabase(() => {
    const initial = projectsDb.createProjectPath('/workspace/active-project');
    assert.equal(initial.outcome, 'created');
    assert.ok(initial.project);

    const conflict = projectsDb.createProjectPath('/workspace/active-project');
    assert.equal(conflict.outcome, 'active_conflict');
    assert.ok(conflict.project);
    assert.equal(conflict.project?.project_id, initial.project?.project_id);
  });
});

test('projectsDb.getProjectPaths bounds recent projects and excludes disposable temp paths', async () => {
  await withIsolatedDatabase(() => {
    const db = getConnection();
    db.prepare(`
      INSERT INTO projects (project_id, project_path, custom_project_name, isStarred)
      VALUES (?, ?, ?, ?)
    `).run('old', '/workspace/old', 'old', 0);
    db.prepare(`
      INSERT INTO projects (project_id, project_path, custom_project_name, isStarred)
      VALUES (?, ?, ?, ?)
    `).run('recent', '/workspace/recent', 'recent', 0);
    db.prepare(`
      INSERT INTO projects (project_id, project_path, custom_project_name, isStarred)
      VALUES (?, ?, ?, ?)
    `).run('temp', path.join(tmpdir(), 'throwaway'), 'temp', 0);
    db.prepare(`
      INSERT INTO projects (project_id, project_path, custom_project_name, isStarred)
      VALUES (?, ?, ?, ?)
    `).run('starred-temp', path.join(tmpdir(), 'kept'), 'kept', 1);
    db.prepare(`
      INSERT INTO projects (project_id, project_path, custom_project_name, isStarred)
      VALUES (?, ?, ?, ?)
    `).run('windows-temp', 'C:\\Temp\\throwaway', 'windows-temp', 0);
    db.prepare(`
      INSERT INTO sessions (session_id, provider, project_path, created_at, updated_at)
      VALUES (?, 'codex', ?, ?, ?)
    `).run('old-session', '/workspace/old', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    db.prepare(`
      INSERT INTO sessions (session_id, provider, project_path, created_at, updated_at)
      VALUES (?, 'codex', ?, ?, ?)
    `).run('recent-session', '/workspace/recent', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z');

    const rows = projectsDb.getProjectPaths({ limit: 2, excludePathRoot: tmpdir() });

    assert.deepEqual(rows.map((row) => row.project_id), ['starred-temp', 'recent']);
    assert.equal(rows.some((row) => row.project_id === 'temp'), false);
    assert.equal(
      projectsDb.getProjectPaths({ limit: 10, excludePathRoot: 'C:\\Temp' })
        .some((row) => row.project_id === 'windows-temp'),
      false,
    );
  });
});

test('uses the chatmux root and leaves the populated old root untouched without DATABASE_PATH', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const previousHome = process.env.HOME;
  const temporaryHome = await mkdtemp(path.join(tmpdir(), 'projects-db-home-'));
  const oldDatabasePath = path.join(temporaryHome, `.${['cloud', 'cli'].join('')}`, 'auth.db');
  const databasePath = path.join(temporaryHome, '.chatmux', 'auth.db');

  await mkdir(path.dirname(oldDatabasePath), { recursive: true });
  const oldDatabase = new Database(oldDatabasePath);
  oldDatabase.exec(`
    CREATE TABLE preserved_data (value TEXT NOT NULL);
    INSERT INTO preserved_data (value) VALUES ('old-root-data');
  `);
  oldDatabase.close();

  const oldDatabaseContents = await readFile(oldDatabasePath);
  closeConnection();
  process.env.HOME = temporaryHome;
  delete process.env.DATABASE_PATH;

  try {
    assert.equal(getDatabasePath(), databasePath);
    await initializeDatabase();

    assert.ok((await stat(databasePath)).isFile());
    assert.deepEqual(await readFile(oldDatabasePath), oldDatabaseContents);

    const preservedDatabase = new Database(oldDatabasePath, { readonly: true });
    const preservedRow = preservedDatabase.prepare('SELECT value FROM preserved_data').get() as { value: string };
    assert.equal(preservedRow.value, 'old-root-data');
    preservedDatabase.close();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    await rm(temporaryHome, { recursive: true, force: true });
  }
});
