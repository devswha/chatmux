import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { projectsDb, sessionsDb } from '@/modules/database/index.js';
import { getProjectsWithSessions } from '@/modules/projects/services/projects-with-sessions-fetch.service.js';

type Stubs = {
  getProjectPaths: typeof projectsDb.getProjectPaths;
  getInitialSessionPagesByProject: typeof sessionsDb.getInitialSessionPagesByProject;
};

type CapturedReads = {
  sessionsLimit?: number;
  projectOptions?: Parameters<typeof projectsDb.getProjectPaths>[0];
  projectPaths?: readonly string[];
};

function withStubs(total: number, run: (captured: CapturedReads) => Promise<void>): Promise<void> {
  const original: Stubs = {
    getProjectPaths: projectsDb.getProjectPaths,
    getInitialSessionPagesByProject: sessionsDb.getInitialSessionPagesByProject,
  };
  const captured: CapturedReads = {};
  // custom_project_name is set so getProjectsWithSessions skips filesystem displayName derivation.
  (projectsDb as unknown as { getProjectPaths: (options?: unknown) => unknown }).getProjectPaths = (options) => {
    captured.projectOptions = options as CapturedReads['projectOptions'];
    return [{ project_id: 'p1', project_path: '/ws/p1', custom_project_name: 'p1', isStarred: 0 }];
  };
  (sessionsDb as unknown as { getInitialSessionPagesByProject: (limit: number, paths: readonly string[]) => unknown[] })
    .getInitialSessionPagesByProject = (limit, paths) => {
      captured.sessionsLimit = limit;
      captured.projectPaths = paths;
      return total > 0
        ? [{
            session_id: 's1',
            provider: 'gjc',
            project_path: '/ws/p1',
            custom_name: null,
            created_at: '2026-01-01T00:00:00.000Z',
            updated_at: '2026-01-01T00:00:00.000Z',
            total,
          }]
        : [];
    };

  return run(captured).finally(() => {
    projectsDb.getProjectPaths = original.getProjectPaths;
    sessionsDb.getInitialSessionPagesByProject = original.getInitialSessionPagesByProject;
  });
}

test('getProjectsWithSessions caps the initial eager session slice at 5 when no limit is given', async () => {
  await withStubs(42, async (captured) => {
    const projects = await getProjectsWithSessions({ skipSynchronization: true });
    assert.equal(captured.sessionsLimit, 5, 'eager per-project session slice must default to 5');
    assert.deepEqual(captured.projectOptions, { limit: 100, excludePathRoot: os.tmpdir() });
    assert.deepEqual(captured.projectPaths, ['/ws/p1'], 'sessions are read only for the bounded project slice');
    assert.equal(projects.length, 1);
    assert.equal(projects[0].sessionMeta.total, 42, 'total reflects the full session count for lazy-load');
    assert.equal(projects[0].sessionMeta.hasMore, true, 'hasMore lets the frontend lazy-load the rest');
  });
});

test('getProjectsWithSessions respects an explicit sessionsLimit (no forced cap)', async () => {
  await withStubs(42, async (captured) => {
    await getProjectsWithSessions({ skipSynchronization: true, sessionsLimit: 12 });
    assert.equal(captured.sessionsLimit, 12, 'an explicit sessionsLimit overrides the small default');
  });
});


test('generateDisplayName caches package.json reads instead of re-reading per call', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'chatmux-display-name-'));
  try {
    const { generateDisplayName } = await import('@/modules/projects/services/projects-with-sessions-fetch.service.js');
    await writeFile(path.join(tempRoot, 'package.json'), JSON.stringify({ name: 'first-name' }), 'utf8');
    assert.equal(await generateDisplayName(path.basename(tempRoot), tempRoot), 'first-name');

    // A change inside the TTL window must serve the cached name: the project
    // list endpoint calls this once per project row on every refresh, and the
    // cache is what keeps that from re-reading thousands of files.
    await writeFile(path.join(tempRoot, 'package.json'), JSON.stringify({ name: 'second-name' }), 'utf8');
    assert.equal(await generateDisplayName(path.basename(tempRoot), tempRoot), 'first-name');
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
