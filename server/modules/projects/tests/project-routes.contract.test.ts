import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import type { NextFunction, Request, Response } from 'express';

const databaseDir = await mkdtemp(path.join(os.homedir(), 'chatmux-project-routes-'));
process.env.DATABASE_PATH = path.join(databaseDir, 'projects.db');
process.env.CHATMUX_AUTH = 'none';

const [{ default: express }, { default: projectRoutes }, database, auth] = await Promise.all([
  import('express'),
  import('../projects.routes.js'),
  import('@/modules/database/index.js'),
  import('../../../middleware/auth.js'),
]);

const { initializeDatabase, projectsDb, sessionsDb } = database;
const { authenticateToken } = auth;
const read = (relativePath: string) => readFileSync(new URL(relativePath, import.meta.url), 'utf8');

let server: Server;
let baseUrl: string;
let projectId: string;

async function rename(displayName: unknown) {
  const response = await fetch(`${baseUrl}/api/projects/${projectId}/rename`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ displayName }),
  });
  return { status: response.status, body: await response.json() };
}

before(async () => {
  await initializeDatabase();
  const registration = projectsDb.createProjectPath('/workspace/project-rename-contract');
  assert.ok(registration.project);
  projectId = registration.project.project_id;

  const app = express();
  app.use(express.json());
  app.use('/api/projects', authenticateToken, projectRoutes);
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const statusCode = typeof error === 'object' && error !== null && 'statusCode' in error
      ? Number(error.statusCode)
      : 500;
    const code = typeof error === 'object' && error !== null && 'code' in error
      ? String(error.code)
      : 'INTERNAL_ERROR';
    res.status(statusCode).json({
      error: error instanceof Error ? error.message : 'Internal error',
      code,
    });
  });
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await rm(databaseDir, { recursive: true, force: true });
});

test('project creation is removed without changing the authenticated display-name route', () => {
  const routes = read('../projects.routes.ts');
  const service = read('../services/project-management.service.ts');
  const exports = read('../index.ts');
  const serverIndex = read('../../../index.js');

  assert.doesNotMatch(routes, /createProject|\/create-project/);
  assert.match(routes, /router\.put\('\/:projectId\/rename'/);
  assert.match(routes, /updateProjectDisplayName\(projectId, displayName\)/);
  assert.match(service, /export function updateProjectDisplayName/);
  assert.match(exports, /updateProjectDisplayName/);
  assert.match(serverIndex, /app\.use\('\/api\/projects', authenticateToken, projectModuleRoutes\)/);
});

test('authenticated rename persists trimmed and blank display names', async () => {
  let response = await rename('  Renamed Project  ');
  assert.deepEqual(response, { status: 200, body: { success: true } });
  assert.equal(projectsDb.getProjectById(projectId)?.custom_project_name, 'Renamed Project');

  response = await rename('   ');
  assert.deepEqual(response, { status: 200, body: { success: true } });
  assert.equal(projectsDb.getProjectById(projectId)?.custom_project_name, null);
});

test('rename repository failures preserve the existing 500 response', async () => {
  const original = projectsDb.updateCustomProjectNameById;
  projectsDb.updateCustomProjectNameById = () => {
    throw new Error('repository unavailable');
  };

  try {
    assert.deepEqual(await rename('Failure'), {
      status: 500,
      body: { error: 'repository unavailable' },
    });
  } finally {
    projectsDb.updateCustomProjectNameById = original;
  }
});

test('archive and restore project routes are removed', async () => {
  const routes = read('../projects.routes.ts');

  assert.doesNotMatch(routes, /\/archived|\/restore|req\.query\.force/);
  assert.equal((await fetch(`${baseUrl}/api/projects/archived`)).status, 404);
  assert.equal((await fetch(`${baseUrl}/api/projects/${projectId}/restore`, {
    method: 'POST',
  })).status, 404);
});

test('project deletion permanently removes its sessions and transcript files', async () => {
  const projectPath = path.join(databaseDir, 'delete-project');
  const transcriptPath = path.join(databaseDir, 'delete-session.jsonl');
  await writeFile(transcriptPath, '{"type":"message"}\n');

  const registration = projectsDb.createProjectPath(projectPath);
  assert.ok(registration.project);
  const deletedProjectId = registration.project.project_id;
  const deletedSessionId = sessionsDb.createSession(
    'delete-provider-session',
    'claude',
    projectPath,
    'Delete me',
    undefined,
    undefined,
    transcriptPath,
  );

  const response = await fetch(`${baseUrl}/api/projects/${deletedProjectId}`, {
    method: 'DELETE',
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { success: true, action: 'deleted' });
  assert.equal(projectsDb.getProjectById(deletedProjectId), null);
  assert.equal(sessionsDb.getSessionById(deletedSessionId), null);
  await assert.rejects(
    access(transcriptPath),
    (error: NodeJS.ErrnoException) => error.code === 'ENOENT',
  );
});

test('project deletion rejects transcripts shared with sessions outside the project', async () => {
  const sharedTranscriptPath = path.join(databaseDir, 'shared-session.jsonl');
  await writeFile(sharedTranscriptPath, '{"type":"message"}\n');
  const targetPath = path.join(databaseDir, 'shared-target');
  const survivorPath = path.join(databaseDir, 'shared-survivor');
  const targetProject = projectsDb.createProjectPath(targetPath).project;
  assert.ok(targetProject);
  const targetSessionId = sessionsDb.createSession(
    'shared-target-session',
    'claude',
    targetPath,
    undefined,
    undefined,
    undefined,
    sharedTranscriptPath,
  );
  const survivorSessionId = sessionsDb.createSession(
    'shared-survivor-session',
    'claude',
    survivorPath,
    undefined,
    undefined,
    undefined,
    sharedTranscriptPath,
  );

  const response = await fetch(`${baseUrl}/api/projects/${targetProject.project_id}`, {
    method: 'DELETE',
  });
  const body = await response.json() as { code?: string };

  assert.equal(response.status, 409);
  assert.equal(body.code, 'PROJECT_TRANSCRIPT_SHARED');
  assert.ok(projectsDb.getProjectById(targetProject.project_id));
  assert.ok(sessionsDb.getSessionById(targetSessionId));
  assert.ok(sessionsDb.getSessionById(survivorSessionId));
  await access(sharedTranscriptPath);
});

test('project deletion retains database rows when transcript removal fails', async () => {
  const projectPath = path.join(databaseDir, 'unlink-failure-project');
  const directoryTranscriptPath = path.join(databaseDir, 'directory-transcript');
  await mkdir(directoryTranscriptPath);
  const targetProject = projectsDb.createProjectPath(projectPath).project;
  assert.ok(targetProject);
  const targetSessionId = sessionsDb.createSession(
    'unlink-failure-session',
    'claude',
    projectPath,
    undefined,
    undefined,
    undefined,
    directoryTranscriptPath,
  );

  const response = await fetch(`${baseUrl}/api/projects/${targetProject.project_id}`, {
    method: 'DELETE',
  });

  assert.equal(response.status, 500);
  assert.ok(projectsDb.getProjectById(targetProject.project_id));
  assert.ok(sessionsDb.getSessionById(targetSessionId));
  await access(directoryTranscriptPath);
});
