import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

import { validateCommand } from '../utils/commandParser.js';

test('TaskMaster routes and background mounts stay removed', () => {
  const serverIndex = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const projectRoutes = readFileSync(
    new URL('../modules/projects/projects.routes.ts', import.meta.url),
    'utf8',
  );

  assert.doesNotMatch(serverIndex, /routes\/taskmaster|routes\/mcp-utils|\/api\/taskmaster|\/api\/mcp-utils/);
  assert.doesNotMatch(projectRoutes, /projects-has-taskmaster|\/:projectId\/taskmaster/);
});

test('TaskMaster UI and server modules stay absent', () => {
  assert.equal(existsSync(new URL('../../src/components/task-master', import.meta.url)), false);
  assert.equal(existsSync(new URL('../../src/components/prd-editor', import.meta.url)), false);
  assert.equal(existsSync(new URL('./taskmaster.js', import.meta.url)), false);
  assert.equal(existsSync(new URL('./mcp-utils.js', import.meta.url)), false);
  assert.equal(existsSync(new URL('../utils/taskmaster-websocket.js', import.meta.url)), false);
  assert.equal(existsSync(new URL('../utils/mcp-detector.js', import.meta.url)), false);
});

test('task-master is rejected while generic safe commands remain allowed', () => {
  assert.equal(validateCommand('task-master --version').allowed, false);
  assert.equal(validateCommand('find . -maxdepth 1').allowed, true);
});
