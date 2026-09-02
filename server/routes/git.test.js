import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertSafeRepositoryRelativePath,
  normalizeRepositoryRelativeFilePath,
  parseGitLogWithStats,
  parseGitStatusOutput,
  parseStatusEntriesZ,
  resolvePathInsideProject,
  selectExactStatusEntry,
} from './git.js';

// Builds `git status --porcelain=v1 -z` output: NUL-separated entries with a
// trailing NUL, exactly as git emits it.
const porcelain = (...entries) => entries.join('\0') + '\0';

test('parseGitStatusOutput buckets files and reports index-side staging', () => {
  const output = porcelain(
    'M  staged-modified.ts',
    ' M unstaged-modified.ts',
    'MM staged-and-unstaged.ts',
    'A  staged-new.ts',
    'D  staged-deleted.ts',
    ' D unstaged-deleted.ts',
    '?? untracked.ts',
  );

  const result = parseGitStatusOutput(output);

  assert.deepEqual(result.modified, ['staged-modified.ts', 'unstaged-modified.ts', 'staged-and-unstaged.ts']);
  assert.deepEqual(result.added, ['staged-new.ts']);
  assert.deepEqual(result.deleted, ['staged-deleted.ts', 'unstaged-deleted.ts']);
  assert.deepEqual(result.untracked, ['untracked.ts']);
  // Only index-side (X) changes count as staged.
  assert.deepEqual(result.staged, [
    'staged-modified.ts',
    'staged-and-unstaged.ts',
    'staged-new.ts',
    'staged-deleted.ts',
  ]);
});

test('parseGitStatusOutput keeps paths with spaces intact (-z output has no quoting)', () => {
  const result = parseGitStatusOutput(porcelain('M  src/my folder/some file.ts'));
  assert.deepEqual(result.modified, ['src/my folder/some file.ts']);
  assert.deepEqual(result.staged, ['src/my folder/some file.ts']);
});

test('parseGitStatusOutput tracks the post-rename path and skips the original', () => {
  const output = porcelain('R  renamed-to.ts', 'renamed-from.ts', ' M other.ts');
  const result = parseGitStatusOutput(output);

  assert.deepEqual(result.modified, ['renamed-to.ts', 'other.ts']);
  assert.deepEqual(result.staged, ['renamed-to.ts']);
  // The pre-rename path is metadata, not a change entry.
  assert.equal(JSON.stringify(result).includes('renamed-from.ts'), false);
});

test('parseGitStatusOutput never reports merge conflicts as staged', () => {
  const output = porcelain('UU conflicted.ts', 'AA both-added.ts', 'DD both-deleted.ts');
  const result = parseGitStatusOutput(output);

  assert.deepEqual(result.modified, ['conflicted.ts', 'both-added.ts', 'both-deleted.ts']);
  assert.deepEqual(result.staged, []);
});

test('parseGitStatusOutput handles empty output', () => {
  assert.deepEqual(parseGitStatusOutput(''), {
    modified: [],
    added: [],
    deleted: [],
    untracked: [],
    staged: [],
  });
});

// Builds one `git log --pretty=format:%H%x1f%P%x1f%D%x1f%an%x1f%ae%x1f%ad%x1f%s` line.
const US = '';
const logLine = (hash, parents, refs, subject) =>
  [hash, parents, refs, 'Alice', 'a@x.com', '2026-07-06T10:00:00+03:00', subject].join(US);

test('parseGitLogWithStats parses commits with parents, refs, and shortstat lines', () => {
  const output = [
    logLine('c3', 'c2', 'HEAD -> main, origin/main, tag: v1.0', 'feat: add | pipes | to subject'),
    ' 3 files changed, 10 insertions(+), 2 deletions(-)',
    '',
    logLine('c2', 'c1 c0', '', 'Merge branch feature'),
    '',
    logLine('c0', '', '', 'initial commit'),
    ' 1 file changed, 1 insertion(+)',
  ].join('\n');

  const commits = parseGitLogWithStats(output);

  assert.equal(commits.length, 3);
  assert.deepEqual(commits[0].parents, ['c2']);
  assert.deepEqual(commits[0].refs, ['HEAD -> main', 'origin/main', 'tag: v1.0']);
  // Pipes in the subject survive because fields are joined with .
  assert.equal(commits[0].message, 'feat: add | pipes | to subject');
  assert.equal(commits[0].stats, '3 files changed, 10 insertions(+), 2 deletions(-)');

  // Merge commit: two parents, no shortstat line.
  assert.deepEqual(commits[1].parents, ['c1', 'c0']);
  assert.equal(commits[1].stats, '');

  // Root commit: no parents.
  assert.deepEqual(commits[2].parents, []);
  assert.equal(commits[2].stats, '1 file changed, 1 insertion(+)');
});

test('parseGitLogWithStats handles empty output', () => {
  assert.deepEqual(parseGitLogWithStats(''), []);
});

test('assertSafeRepositoryRelativePath refuses the repository root and traversal', () => {
  for (const bad of ['', '.', './', '/', 'src/..', '../etc/passwd', 'a/./b', 'a//b']) {
    assert.throws(() => assertSafeRepositoryRelativePath(normalizeRepositoryRelativeFilePath(bad)), /Invalid file path/, `should reject ${JSON.stringify(bad)}`);
  }
  assert.equal(assertSafeRepositoryRelativePath(normalizeRepositoryRelativeFilePath('./src/a.ts')), 'src/a.ts');
  assert.equal(assertSafeRepositoryRelativePath(normalizeRepositoryRelativeFilePath('newdir/')), 'newdir');
  assert.equal(assertSafeRepositoryRelativePath(normalizeRepositoryRelativeFilePath('sp ace.txt')), 'sp ace.txt');
  // Leading slashes have always been stripped: the value is repository-relative, never absolute.
  assert.equal(assertSafeRepositoryRelativePath(normalizeRepositoryRelativeFilePath('/abs/path')), 'abs/path');
});

test('parseStatusEntriesZ reads porcelain -z output including renames, directories and unquoted names', () => {
  // Captured from `git status --porcelain=v1 -z -- .` in a scratch repository.
  const output = 'R  src/renamed.txt\0src/keep.txt\0 M tracked.txt\0?? newdir/\0?? quo"te.txt\0?? sp ace.txt\0';
  assert.deepEqual(parseStatusEntriesZ(output), [
    { code: 'R ', path: 'src/renamed.txt', isDirectory: false },
    { code: ' M', path: 'tracked.txt', isDirectory: false },
    { code: '??', path: 'newdir', isDirectory: true },
    { code: '??', path: 'quo"te.txt', isDirectory: false },
    { code: '??', path: 'sp ace.txt', isDirectory: false },
  ]);
  assert.deepEqual(parseStatusEntriesZ(''), []);
});

test('selectExactStatusEntry only yields the single entry that is the requested path', () => {
  assert.equal(selectExactStatusEntry('', 'missing.txt'), null);
  assert.deepEqual(selectExactStatusEntry(' M tracked.txt\0', 'tracked.txt'), { code: ' M', path: 'tracked.txt', isDirectory: false });
  assert.deepEqual(selectExactStatusEntry('?? newdir/\0', 'newdir'), { code: '??', path: 'newdir', isDirectory: true });

  const wholeTree = 'R  src/renamed.txt\0src/keep.txt\0 M tracked.txt\0?? newdir/\0';
  assert.throws(() => selectExactStatusEntry(wholeTree, '.'), /git reports 3 entries/, 'a pathspec that fans out is refused before any rm or restore');
  assert.throws(() => selectExactStatusEntry(' M src/a.ts\0 M src/b.ts\0', 'src'), /git reports 2 entries/);
  assert.throws(() => selectExactStatusEntry(' M src/a.ts\0', 'src'), /reports "src\/a.ts" instead/, 'a directory holding tracked changes is not itself an entry');
});

test('resolvePathInsideProject keeps destructive targets strictly inside the project directory', () => {
  const root = '/repo';
  assert.equal(resolvePathInsideProject(root, 'app/src/a.ts', '/repo/app'), '/repo/app/src/a.ts');
  assert.throws(() => resolvePathInsideProject(root, 'other/a.ts', '/repo/app'), /outside the project directory/, 'a sibling directory under the same toplevel is off limits');
  assert.throws(() => resolvePathInsideProject(root, 'app', '/repo/app'), /outside the project directory/, 'the project directory itself is never a target');
  assert.throws(() => resolvePathInsideProject(root, 'application/a.ts', '/repo/app'), /outside the project directory/, 'prefix collisions do not count as inside');
});
