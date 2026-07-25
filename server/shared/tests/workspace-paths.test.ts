import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  FORBIDDEN_WORKSPACE_PATHS,
  normalizeProjectPath,
  sanitizeLeafDirectoryName,
  validateWorkspacePath,
  WORKSPACES_ROOT,
} from '@/shared/workspace-paths.js';
import { validateWorkspacePath as validateWorkspacePathFromUtils } from '@/shared/utils.js';

test('workspace paths reject traversal, system paths, and locations outside the workspace root', async () => {
  const traversal = await validateWorkspacePath(path.join(WORKSPACES_ROOT, '..'));
  assert.equal(traversal.valid, false);

  const absoluteSystemPath = await validateWorkspacePath('/etc');
  assert.equal(absoluteSystemPath.valid, false);

  const outsideHome = await validateWorkspacePath(path.dirname(WORKSPACES_ROOT));
  assert.equal(outsideHome.valid, false);

  for (const forbiddenPath of FORBIDDEN_WORKSPACE_PATHS.filter((candidate) => candidate.startsWith('/'))) {
    const result = await validateWorkspacePath(forbiddenPath);
    assert.equal(result.valid, false, forbiddenPath);
  }
});

test('workspace paths reject symlinks that escape the workspace root and allow normal child paths', async () => {
  const tempDir = await mkdtemp(path.join(os.homedir(), '.chatmux-workspace-paths-'));
  const escapedLink = path.join(tempDir, 'escaped');

  try {
    await symlink(os.tmpdir(), escapedLink, 'dir');
    const escaped = await validateWorkspacePath(escapedLink);
    assert.deepEqual(escaped, {
      valid: false,
      error: 'Workspace path must be within the allowed workspace root: ' + WORKSPACES_ROOT,
    });

    const normalChild = await validateWorkspacePath(path.join(tempDir, 'project'));
    assert.equal(normalChild.valid, true);
    assert.equal(normalChild.resolvedPath, path.join(tempDir, 'project'));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('normalization and leaf names reject traversal forms while preserving valid names', () => {
  assert.equal(normalizeProjectPath('  /tmp/project/../workspace/  '), '/tmp/workspace');
  assert.equal(normalizeProjectPath('\\\\?\\C:\\workspace\\project\\'), 'C:\\workspace\\project');

  for (const input of ['', '   ', '..', '../project', '/project', 'nested/project', 'a\\b']) {
    assert.throws(() => sanitizeLeafDirectoryName(input));
  }

  // Percent-encoded sequences are not decoded before use, so they stay literal
  // directory names rather than traversal, and a bare "." resolves to the root
  // itself. Both are accepted unchanged; callers join them under an already
  // validated root.
  assert.equal(sanitizeLeafDirectoryName('%2e%2e'), '%2e%2e');
  assert.equal(sanitizeLeafDirectoryName('.'), '.');

  assert.equal(sanitizeLeafDirectoryName('  project-01  '), 'project-01');
  assert.equal(validateWorkspacePathFromUtils, validateWorkspacePath);
});
