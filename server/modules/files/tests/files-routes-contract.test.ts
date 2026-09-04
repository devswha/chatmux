import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';

import express from 'express';

const workspaceRoot = await mkdtemp(path.join(os.homedir(), 'chatmux-files-workspace-'));
const databaseDir = await mkdtemp(path.join(os.homedir(), 'chatmux-files-db-'));
process.env.DATABASE_PATH = path.join(databaseDir, 'files.db');
process.env.CHATMUX_AUTH = 'none';

const { default: filesRoutes } = await import('../files.routes.js');
const { initializeDatabase, projectsDb } = await import('@/modules/database/index.js');

let projectRoot: string;
let projectId: string;
let server: Server;
let baseUrl: string;

async function request(pathname: string, method = 'GET', body?: unknown) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: body instanceof FormData ? {} : body === undefined ? {} : { 'content-type': 'application/json' },
    body: body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body),
  });
  const contentType = response.headers.get('content-type') ?? '';
  return {
    status: response.status,
    body: contentType.includes('application/json') ? await response.json() : await response.text(),
  };
}

before(async () => {
  projectRoot = path.join(workspaceRoot, 'project');
  await mkdir(projectRoot);
  await mkdir(path.join(projectRoot, 'directory'));
  await writeFile(path.join(projectRoot, 'existing.txt'), 'before');
  await initializeDatabase();
  const project = projectsDb.createProjectPath(projectRoot);
  assert.ok(project.project);
  projectId = project.project.project_id;

  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(filesRoutes);
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await rm(workspaceRoot, { recursive: true, force: true });
  await rm(databaseDir, { recursive: true, force: true });
});

test('list, read, and write retain their HTTP contracts', async () => {
  let response = await request(`/api/projects/${projectId}/files`, 'GET');
  assert.equal(response.status, 200);
  assert.ok(Array.isArray(response.body));
  assert.deepEqual(Object.keys(response.body[0]).sort(), ['children', 'modified', 'name', 'path', 'permissions', 'permissionsRwx', 'size', 'type']);
  response = await request('/api/projects/missing/files');
  assert.equal(response.status, 404);
  assert.deepEqual(response.body, { error: 'Project not found' });

  response = await request(`/api/projects/${projectId}/file?filePath=existing.txt`);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { content: 'before', path: path.join(projectRoot, 'existing.txt') });

  response = await request(`/api/projects/${projectId}/file`, 'PUT', { filePath: 'existing.txt', content: 'after' });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { success: true, path: path.join(projectRoot, 'existing.txt'), message: 'File saved successfully' });
  assert.equal(await readFile(path.join(projectRoot, 'existing.txt'), 'utf8'), 'after');

  response = await request(`/api/projects/${projectId}/file?filePath=../outside.txt`);
  assert.equal(response.status, 403);
  assert.deepEqual(response.body, { error: 'Path must be under project root' });

  response = await request(`/api/projects/${projectId}/file?filePath=missing.txt`);
  assert.equal(response.status, 404);
  assert.deepEqual(response.body, { error: 'File not found' });
});

test('binary content serving and write failures retain their HTTP contracts', async () => {
  const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
  await writeFile(path.join(projectRoot, 'image.png'), pngBytes);

  const binary = await fetch(`${baseUrl}/api/projects/${projectId}/files/content?path=image.png`);
  assert.equal(binary.status, 200);
  assert.equal(binary.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await binary.arrayBuffer()), pngBytes);

  let response = await request(`/api/projects/${projectId}/files/content`);
  assert.equal(response.status, 400);
  assert.deepEqual(response.body, { error: 'Invalid file path' });

  response = await request(`/api/projects/${projectId}/files/content?path=../outside.png`);
  assert.equal(response.status, 403);
  assert.deepEqual(response.body, { error: 'Path must be under project root' });

  response = await request(`/api/projects/${projectId}/files/content?path=missing.png`);
  assert.equal(response.status, 404);
  assert.deepEqual(response.body, { error: 'File not found' });

  response = await request('/api/projects/missing/files/content?path=image.png');
  assert.equal(response.status, 404);
  assert.deepEqual(response.body, { error: 'Project not found' });

  response = await request(`/api/projects/${projectId}/file`, 'PUT', { filePath: '../outside.txt', content: 'nope' });
  assert.equal(response.status, 403);
  assert.deepEqual(response.body, { error: 'Path must be under project root' });

  response = await request(`/api/projects/missing/file`, 'PUT', { filePath: 'existing.txt', content: 'nope' });
  assert.equal(response.status, 404);
  assert.deepEqual(response.body, { error: 'Project not found' });

  assert.equal(await readFile(path.join(projectRoot, 'existing.txt'), 'utf8'), 'after');
});

test('project HTML and SVG are sandboxed documents rather than executable app-origin content', async () => {
  for (const [name, content] of [['untrusted.html', '<script>window.projectScriptRan=true</script>'],
    ['untrusted.svg', '<svg xmlns="http://www.w3.org/2000/svg"><script>window.projectScriptRan=true</script></svg>']]) {
    await writeFile(path.join(projectRoot, name!), content!);
    const response = await fetch(`${baseUrl}/api/projects/${projectId}/files/content?path=${name}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-security-policy'), 'sandbox');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(await response.text(), content);
  }
});
