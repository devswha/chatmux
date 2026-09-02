import assert from 'node:assert/strict';
import { promises as fsPromises } from 'node:fs';
import { lstat, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  isGitMetadataPath,
  openProjectFileForWrite,
  resolveProjectEntryForMutation,
  resolveProjectFileForRead,
  resolveProjectFileForWrite,
} from '@/shared/project-file-containment.js';

test('project file containment rejects symlink escapes while allowing canonical project paths', async () => {
  const tempDir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'project-file-containment-')));
  const projectRoot = path.join(tempDir, 'project');
  const projectRootLink = path.join(tempDir, 'decoy-project');
  const outsideRoot = path.join(tempDir, 'outside');
  const insideFile = path.join(projectRoot, 'inside.txt');
  const outsideFile = path.join(outsideRoot, 'secret.txt');

  try {
    await Promise.all([mkdir(projectRoot), mkdir(outsideRoot)]);
    await Promise.all([
      writeFile(insideFile, 'inside'),
      writeFile(outsideFile, 'secret'),
      symlink(projectRoot, projectRootLink, 'dir'),
      symlink(insideFile, path.join(projectRoot, 'inside-link.txt'), 'file'),
      symlink(outsideFile, path.join(projectRoot, 'escaped.txt'), 'file'),
      symlink(outsideRoot, path.join(projectRoot, 'escaped-dir'), 'dir'),
    ]);

    assert.equal(
      await resolveProjectFileForRead(projectRootLink, path.join(projectRootLink, 'inside.txt')),
      insideFile,
    );

    const newFilePath = await resolveProjectFileForWrite(projectRootLink, path.join(projectRootLink, 'new.txt'));
    assert.equal(newFilePath, path.join(projectRoot, 'new.txt'));
    await writeFile(newFilePath!, 'new');

    assert.equal(
      await resolveProjectFileForRead(projectRootLink, path.join(projectRootLink, 'escaped.txt')),
      null,
    );
    assert.equal(
      await resolveProjectFileForWrite(projectRootLink, path.join(projectRootLink, 'escaped.txt')),
      null,
    );
    assert.equal(
      await resolveProjectFileForWrite(projectRootLink, path.join(projectRootLink, 'escaped-dir', 'new.txt')),
      null,
    );

    const containedLinkEntry = await resolveProjectEntryForMutation(
      projectRoot,
      path.join(projectRoot, 'inside-link.txt'),
    );
    assert.equal(containedLinkEntry, path.join(projectRoot, 'inside-link.txt'));
    assert.equal((await lstat(containedLinkEntry!)).isSymbolicLink(), true);
    assert.equal(
      await resolveProjectEntryForMutation(projectRoot, path.join(projectRoot, 'escaped.txt')),
      path.join(projectRoot, 'escaped.txt'),
    );
    assert.equal(
      await resolveProjectEntryForMutation(projectRoot, path.join(projectRoot, 'escaped-dir', 'new.txt')),
      null,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
test('project file containment validates nested new paths from the nearest existing ancestor', async () => {
  const tempDir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'project-file-containment-')));
  const projectRoot = path.join(tempDir, 'project');
  const outsideRoot = path.join(tempDir, 'outside');

  try {
    await Promise.all([mkdir(projectRoot), mkdir(outsideRoot)]);
    await symlink(outsideRoot, path.join(projectRoot, 'escape'), 'dir');
    await symlink(path.join(outsideRoot, 'missing'), path.join(projectRoot, 'dangling'), 'file');

    assert.equal(
      await resolveProjectFileForWrite(projectRoot, path.join(projectRoot, 'nested', 'new.txt')),
      path.join(projectRoot, 'nested', 'new.txt'),
    );
    assert.equal(
      await resolveProjectFileForWrite(projectRoot, path.join(projectRoot, 'escape', 'nested', 'new.txt')),
      null,
    );
    assert.equal(
      await resolveProjectFileForWrite(projectRoot, path.join(projectRoot, 'dangling')),
      null,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('project file writes use the same regular file object that passed validation', async () => {
  const tempDir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'project-file-containment-')));
  const projectRoot = path.join(tempDir, 'project');
  const outsideRoot = path.join(tempDir, 'outside');
  const insideFile = path.join(projectRoot, 'inside.txt');
  const outsideFile = path.join(outsideRoot, 'outside.txt');

  try {
    await Promise.all([mkdir(projectRoot), mkdir(outsideRoot)]);
    await Promise.all([
      writeFile(insideFile, 'old'),
      writeFile(outsideFile, 'outside'),
    ]);
    await symlink(outsideFile, path.join(projectRoot, 'escape.txt'), 'file');

    const writable = await openProjectFileForWrite(projectRoot, insideFile);
    assert.ok(writable);
    await writable.handle.truncate(0);
    await writable.handle.writeFile('new', 'utf8');
    await writable.handle.close();

    assert.equal(await readFile(insideFile, 'utf8'), 'new');
    assert.equal(
      await openProjectFileForWrite(projectRoot, path.join(projectRoot, 'escape.txt')),
      null,
    );
    assert.equal(await readFile(outsideFile, 'utf8'), 'outside');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('project file containment keeps .git metadata out of reach for reads, writes, and mutations', async () => {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'containment-git-'));
  try {
    await fsPromises.mkdir(path.join(root, '.git', 'hooks'), { recursive: true });
    await fsPromises.writeFile(path.join(root, '.git', 'config'), '[core]\n');
    await fsPromises.writeFile(path.join(root, '.gitignore'), 'node_modules\n');
    await fsPromises.writeFile(path.join(root, 'notes.md'), '# notes\n');

    assert.equal(await resolveProjectFileForRead(root, path.join(root, '.git', 'config')), null, 'git config can carry remote credentials and fsmonitor commands');
    assert.equal(await resolveProjectFileForWrite(root, path.join(root, '.git', 'config')), null);
    assert.equal(await resolveProjectFileForWrite(root, path.join(root, '.git', 'hooks', 'pre-commit')), null, 'a hook written here would run on the app\'s next git commit');
    assert.equal(await resolveProjectEntryForMutation(root, path.join(root, '.git')), null);
    assert.equal(await openProjectFileForWrite(root, path.join(root, '.git', 'config')), null);
    assert.equal(isGitMetadataPath(root, path.join(root, '.git')), true);

    assert.equal(await resolveProjectFileForRead(root, path.join(root, '.gitignore')), path.join(await fsPromises.realpath(root), '.gitignore'), 'dotfiles that merely start with .git stay editable');
    assert.ok(await resolveProjectFileForWrite(root, path.join(root, 'notes.md')));
  } finally {
    await fsPromises.rm(root, { recursive: true, force: true });
  }
});
