import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { providerSkillsService } from '@/modules/providers/services/skills.service.js';
import { AppError } from '@/shared/utils.js';

/**
 * Characterization fixtures for OpenCode's documented skill discovery
 * (plan Task 10, https://opencode.ai/docs/skills/).
 *
 * OpenCode's official "Understand discovery" section says:
 * - Project-local: walk up from cwd to the git worktree root, loading each
 *   "SKILL.md" nested one level under skills folders named ".opencode",
 *   ".claude", and ".agents" at every directory along that walk.
 * - Global: the same SKILL.md layout under "~/.config/opencode", "~/.claude",
 *   and "~/.agents".
 * - Command syntax is `/name` (no provider- or scope-specific prefix).
 *
 * `opencode-skills.provider.ts` already walks cwd-to-git-root for the three
 * project-compatible directories and reads the three matching global
 * directories. Every fixture below is run against the existing adapter first;
 * per the task's "characterize before changing" rule, product code is only
 * touched if one of these fixtures goes red against the documented contract.
 */

const patchHomeDir = (nextHomeDir: string) => {
  const original = os.homedir;
  (os as unknown as { homedir: () => string }).homedir = () => nextHomeDir;
  return () => {
    (os as unknown as { homedir: () => string }).homedir = original;
  };
};

const writeSkill = async (
  skillsRoot: string,
  directoryName: string,
  name: string,
  description: string,
): Promise<string> => {
  const skillDir = path.join(skillsRoot, directoryName);
  await fs.mkdir(skillDir, { recursive: true });
  const skillPath = path.join(skillDir, 'SKILL.md');
  await fs.writeFile(
    skillPath,
    `---\nname: ${name}\ndescription: ${description}\n---\n\nBody for ${name}.\n`,
    'utf8',
  );
  return skillPath;
};

const byName = <T extends { name: string }>(items: T[]): Map<string, T> =>
  new Map(items.map((item) => [item.name, item]));

/**
 * Covers every documented project (cwd/parent/repo-root) and global source,
 * exact `/name` command syntax, and scope mapping (project vs user).
 */
test('opencode lists cwd, parent, and repo-root project skills plus all three global compatibility roots', { concurrency: false }, async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-skills-roots-'));
  const repoRoot = path.join(tempRoot, 'repo');
  const workspacePath = path.join(repoRoot, 'packages', 'app');
  await fs.mkdir(path.join(repoRoot, '.git'), { recursive: true });
  await fs.mkdir(workspacePath, { recursive: true });

  const restoreHomeDir = patchHomeDir(tempRoot);
  try {
    // cwd-level project sources.
    await writeSkill(
      path.join(workspacePath, '.opencode', 'skills'),
      'cwd-opencode-dir',
      'cwd-opencode',
      'cwd .opencode skill',
    );
    await writeSkill(
      path.join(workspacePath, '.claude', 'skills'),
      'cwd-claude-dir',
      'cwd-claude',
      'cwd .claude compatibility skill',
    );
    await writeSkill(
      path.join(workspacePath, '.agents', 'skills'),
      'cwd-agents-dir',
      'cwd-agents',
      'cwd .agents compatibility skill',
    );

    // Parent-directory project source (between cwd and repo root).
    await writeSkill(
      path.join(repoRoot, 'packages', '.opencode', 'skills'),
      'parent-opencode-dir',
      'parent-opencode',
      'parent .opencode skill',
    );

    // Repo-root project source.
    await writeSkill(
      path.join(repoRoot, '.opencode', 'skills'),
      'root-opencode-dir',
      'root-opencode',
      'repo root .opencode skill',
    );

    // Global sources: opencode config dir + Claude/Agents compatibility.
    await writeSkill(
      path.join(tempRoot, '.config', 'opencode', 'skills'),
      'global-opencode-dir',
      'global-opencode',
      'global opencode config skill',
    );
    await writeSkill(
      path.join(tempRoot, '.claude', 'skills'),
      'global-claude-dir',
      'global-claude',
      'global claude compatibility skill',
    );
    await writeSkill(
      path.join(tempRoot, '.agents', 'skills'),
      'global-agents-dir',
      'global-agents',
      'global agents compatibility skill',
    );

    const skills = await providerSkillsService.listProviderSkills('opencode', { workspacePath });
    const found = byName(skills);

    for (const name of [
      'cwd-opencode',
      'cwd-claude',
      'cwd-agents',
      'parent-opencode',
      'root-opencode',
    ]) {
      assert.equal(found.get(name)?.scope, 'project', `${name} should be scope=project`);
      assert.equal(found.get(name)?.command, `/${name}`, `${name} should use /name command syntax`);
    }

    for (const name of ['global-opencode', 'global-claude', 'global-agents']) {
      assert.equal(found.get(name)?.scope, 'user', `${name} should be scope=user`);
      assert.equal(found.get(name)?.command, `/${name}`, `${name} should use /name command syntax`);
    }

    assert.equal(skills.length, 8, 'no undeclared foreign skill should appear');
  } finally {
    await restoreHomeDir();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

/**
 * Covers deterministic project-over-user collision ordering: the same skill
 * name in a project directory and a global directory must resolve to a
 * single project-scoped entry (documented project walk is read first).
 */
test('opencode resolves a project/global name collision deterministically to the project entry', { concurrency: false }, async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-skills-collision-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await fs.mkdir(workspacePath, { recursive: true });

  const restoreHomeDir = patchHomeDir(tempRoot);
  try {
    await writeSkill(
      path.join(workspacePath, '.opencode', 'skills'),
      'shared-dir',
      'shared',
      'Project-scoped shared skill',
    );
    await writeSkill(
      path.join(tempRoot, '.config', 'opencode', 'skills'),
      'shared-dir',
      'shared',
      'User-scoped shared skill',
    );

    const run = async () => {
      const skills = await providerSkillsService.listProviderSkills('opencode', { workspacePath });
      const matches = skills.filter((skill) => skill.name === 'shared');
      assert.equal(matches.length, 1, 'colliding names must resolve to exactly one entry');
      assert.equal(matches[0]?.scope, 'project', 'project source must win the collision');
      return matches[0]?.sourcePath;
    };

    const firstRunSourcePath = await run();
    const secondRunSourcePath = await run();
    assert.equal(firstRunSourcePath, secondRunSourcePath, 'collision resolution must be deterministic across runs');
  } finally {
    await restoreHomeDir();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

/**
 * Covers containment: a skill directory symlinked from outside the walked
 * project/global roots must not surface as an OpenCode skill, while a valid
 * sibling skill directory in the same root remains visible.
 */
test('opencode excludes outside-root symlinked skills while keeping valid sibling skills', { concurrency: false }, async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-skills-symlink-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  const outsideRoot = path.join(tempRoot, 'outside');
  await fs.mkdir(workspacePath, { recursive: true });
  await fs.mkdir(outsideRoot, { recursive: true });

  const restoreHomeDir = patchHomeDir(tempRoot);
  try {
    const outsideSkillDir = path.join(outsideRoot, 'escaped-skill');
    await fs.mkdir(outsideSkillDir, { recursive: true });
    await fs.writeFile(
      path.join(outsideSkillDir, 'SKILL.md'),
      '---\nname: escaped\ndescription: outside skill\n---\n\nBody.\n',
      'utf8',
    );

    const projectSkillsDir = path.join(workspacePath, '.opencode', 'skills');
    await fs.mkdir(projectSkillsDir, { recursive: true });
    // A skill directory entry that is itself a symlink pointing outside the walked root.
    await fs.symlink(outsideSkillDir, path.join(projectSkillsDir, 'escaped-link'));

    // A valid sibling skill directory in the same root must still be discovered.
    await writeSkill(projectSkillsDir, 'valid-sibling-dir', 'valid-sibling', 'Valid sibling project skill');

    const skills = await providerSkillsService.listProviderSkills('opencode', { workspacePath });
    const found = byName(skills);

    assert.equal(found.get('escaped'), undefined, 'symlinked skill outside the walked root must not appear as its own foreign source');
    assert.equal(found.get('valid-sibling')?.scope, 'project');
    assert.equal(found.get('valid-sibling')?.command, '/valid-sibling');
  } finally {
    await restoreHomeDir();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

/**
 * Covers malformed markdown resilience: a SKILL.md with invalid YAML
 * frontmatter must not hide sibling skills or throw out of the service.
 */
test('opencode skips malformed SKILL.md frontmatter without hiding valid siblings', { concurrency: false }, async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-skills-malformed-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await fs.mkdir(workspacePath, { recursive: true });

  const restoreHomeDir = patchHomeDir(tempRoot);
  try {
    const projectSkillsDir = path.join(workspacePath, '.opencode', 'skills');
    const malformedSkillDir = path.join(projectSkillsDir, 'malformed-dir');
    await fs.mkdir(malformedSkillDir, { recursive: true });
    await fs.writeFile(
      path.join(malformedSkillDir, 'SKILL.md'),
      '---\nname: [unterminated: flow: collection\n---\n\nBody.\n',
      'utf8',
    );

    await writeSkill(projectSkillsDir, 'valid-dir', 'valid', 'Valid project skill next to a malformed one');

    const skills = await providerSkillsService.listProviderSkills('opencode', { workspacePath });
    const found = byName(skills);

    assert.equal(found.size, 1, 'only the valid sibling skill should surface');
    assert.equal(found.get('valid')?.scope, 'project');
    assert.equal(found.get('valid')?.command, '/valid');
  } finally {
    await restoreHomeDir();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

/**
 * Covers a missing git root: the documented walk must still function using the
 * workspace path itself as the sole project root when no `.git` marker exists.
 */
test('opencode falls back to the workspace path as the sole project root when no git root exists', { concurrency: false }, async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-skills-no-git-'));
  const workspacePath = path.join(tempRoot, 'workspace', 'nested');
  await fs.mkdir(workspacePath, { recursive: true });

  const restoreHomeDir = patchHomeDir(tempRoot);
  try {
    await writeSkill(
      path.join(workspacePath, '.opencode', 'skills'),
      'nested-dir',
      'nested',
      'Nested workspace skill with no git root',
    );
    // A directory above workspacePath that is NOT part of the walk (no git marker exists
    // anywhere, so the walk must not silently extend beyond the workspace path).
    await writeSkill(
      path.join(tempRoot, 'workspace', '.opencode', 'skills'),
      'parent-without-git-dir',
      'parent-without-git',
      'Should not be visible: no git root ties this parent to the walk',
    );

    const skills = await providerSkillsService.listProviderSkills('opencode', { workspacePath });
    const found = byName(skills);

    assert.equal(found.get('nested')?.scope, 'project');
    assert.equal(found.get('parent-without-git'), undefined, 'without a git root, the walk stays at the workspace path');
  } finally {
    await restoreHomeDir();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

/**
 * Covers the documented write behavior: OpenCode has no managed/global write
 * root of its own (it only reads compatibility directories owned by other
 * agents), so `addSkills`/`removeSkill` must fail closed as unsupported.
 */
test('opencode rejects managed skill creation and removal since it owns no writable root', { concurrency: false }, async () => {
  await assert.rejects(
    () => providerSkillsService.addProviderSkills('opencode', {
      entries: [
        {
          directoryName: 'opencode-managed-dir',
          content: '---\nname: opencode-managed\ndescription: Unsupported managed skill\n---\n\nBody.\n',
        },
      ],
    }),
    (error: unknown) => error instanceof AppError && error.code === 'PROVIDER_SKILLS_WRITE_UNSUPPORTED',
  );

  await assert.rejects(
    () => providerSkillsService.removeProviderSkill('opencode', {
      directoryName: 'opencode-managed-dir',
    }),
    (error: unknown) => error instanceof AppError && error.code === 'PROVIDER_SKILLS_WRITE_UNSUPPORTED',
  );
});
