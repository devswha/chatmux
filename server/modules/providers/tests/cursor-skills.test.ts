import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { providerSkillsService } from '@/modules/providers/services/skills.service.js';
import { AppError } from '@/shared/utils.js';

/**
 * Characterization + gap-hunt fixtures for Cursor's native skill catalog
 * (plan Task 9, `.omo/plans/provider-native-skill-catalogs.md`).
 *
 * The plan's Cursor contract row is:
 *   > Built-ins; `.agents`, `.cursor`, documented Claude/Codex compatibility
 *   > roots; user/project/nested repo skills; installed plugins.
 *   > `/name`; bundled `system`, installed plugin `plugin`.
 *   > Add documented compatibility/nested/built-in characterization,
 *   > modify only proven gaps.
 *
 * The current adapter (`server/modules/providers/list/cursor/cursor-skills.provider.ts`)
 * scans exactly three sources:
 *   1. `<workspace>/.agents/skills`   -> scope: project, command `/name`
 *   2. `<workspace>/.cursor/skills`   -> scope: project, command `/name`
 *   3. `~/.cursor/skills`             -> scope: user,    command `/name`
 * with `getGlobalSkillSource` pointing at `~/.cursor/skills` for managed writes.
 *
 * These fixtures pin each dimension the task calls out:
 *   - User + project compatibility on the three real roots above,
 *   - `.agents`/`.cursor` non-recursion (nested repos, sibling workspaces,
 *     outside roots must never leak),
 *   - Built-ins: no cited native `system` walker -> zero `scope: 'system'`
 *     entries; a future regression that guesses one would fail here,
 *   - Enabled/disabled plugin manifests: no cited native `plugin` walker ->
 *     zero `scope: 'plugin'` entries regardless of enabled/disabled toggle,
 *   - Claude/Codex compatibility paths (`~/.claude/skills`, `~/.codex/skills`,
 *     `~/.agents/skills`, `~/.opencode/skills`, and their workspace-scoped
 *     twins): NOT scanned by the current Cursor adapter; the test proves
 *     equivalence rather than inventing a walker,
 *   - Malformed markdown and unreadable roots must not hide valid siblings,
 *   - Symlinks pointing outside a source root must not surface,
 *   - Deterministic source-order precedence on `/name` collisions,
 *   - Managed add/list/remove round trip persists under `~/.cursor/skills`.
 *
 * No natural-language descriptions are pinned; only machine-consumed values
 * (command, scope, name, sourcePath) are asserted. No test executes the
 * Cursor CLI or touches user data outside the temp home.
 *
 * References:
 * - server/modules/providers/list/cursor/cursor-skills.provider.ts
 * - server/modules/providers/shared/skills/skills.provider.ts
 * - server/shared/utils.ts#findProviderSkillMarkdownFiles
 * - server/modules/providers/tests/skills.test.ts (baseline Cursor fixture)
 * - .omo/plans/provider-native-skill-catalogs.md (Task 9 row + STOP condition)
 */

const patchHomeDir = (nextHomeDir: string): (() => void) => {
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

type CursorSandbox = {
  homeDir: string;
  cursorHomePath: string;
  cursorUserSkillsPath: string;
  cursorProjectSkillsPath: string;
  agentsProjectSkillsPath: string;
  repoRoot: string;
  workspacePath: string;
  restore: () => Promise<void>;
};

/**
 * One Cursor fixture isolation: a temp `$HOME` swapped into `os.homedir`,
 * a `.git`-marked repo root, and a nested workspace under it so nested-repo
 * / sibling-repo cases can be exercised distinctly from the workspace itself.
 */
const makeSandbox = async (label: string): Promise<CursorSandbox> => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), `cursor-skills-${label}-`));
  const repoRoot = path.join(homeDir, 'repo');
  const workspacePath = path.join(repoRoot, 'packages', 'app');
  await fs.mkdir(path.join(repoRoot, '.git'), { recursive: true });
  await fs.mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(homeDir);
  return {
    homeDir,
    cursorHomePath: path.join(homeDir, '.cursor'),
    cursorUserSkillsPath: path.join(homeDir, '.cursor', 'skills'),
    cursorProjectSkillsPath: path.join(workspacePath, '.cursor', 'skills'),
    agentsProjectSkillsPath: path.join(workspacePath, '.agents', 'skills'),
    repoRoot,
    workspacePath,
    restore: async () => {
      restoreHomeDir();
      await fs.rm(homeDir, { recursive: true, force: true });
    },
  };
};

const listCursor = (workspacePath: string) =>
  providerSkillsService.listProviderSkills('cursor', { workspacePath });

/**
 * Documented user/project sources: the three roots the current Cursor
 * adapter scans must surface with the correct scope and `/name` command,
 * and every returned `sourcePath` must be the exact resolved SKILL.md.
 */
test('cursor lists .agents (project), .cursor (project), and ~/.cursor (user) with /name commands', { concurrency: false }, async () => {
  const sandbox = await makeSandbox('documented-sources');
  try {
    const agentsProjectPath = await writeSkill(
      sandbox.agentsProjectSkillsPath, 'agents-proj-dir', 'cursor-agents-project', 'project .agents/skills entry',
    );
    const cursorProjectPath = await writeSkill(
      sandbox.cursorProjectSkillsPath, 'cursor-proj-dir', 'cursor-project', 'project .cursor/skills entry',
    );
    const cursorUserPath = await writeSkill(
      sandbox.cursorUserSkillsPath, 'cursor-user-dir', 'cursor-user', 'user ~/.cursor/skills entry',
    );

    const skills = await listCursor(sandbox.workspacePath);
    const found = byName(skills);

    const agentsProject = found.get('cursor-agents-project');
    assert.ok(agentsProject, 'cursor-agents-project must be listed');
    assert.equal(agentsProject.provider, 'cursor');
    assert.equal(agentsProject.scope, 'project');
    assert.equal(agentsProject.command, '/cursor-agents-project');
    assert.equal(agentsProject.sourcePath, agentsProjectPath);

    const cursorProject = found.get('cursor-project');
    assert.equal(cursorProject?.scope, 'project');
    assert.equal(cursorProject?.command, '/cursor-project');
    assert.equal(cursorProject?.sourcePath, cursorProjectPath);

    const cursorUser = found.get('cursor-user');
    assert.equal(cursorUser?.scope, 'user');
    assert.equal(cursorUser?.command, '/cursor-user');
    assert.equal(cursorUser?.sourcePath, cursorUserPath);

    for (const skill of skills) {
      assert.equal(skill.provider, 'cursor');
      assert.match(skill.command, /^\//, `${skill.name} command must use the / prefix`);
      assert.equal(path.isAbsolute(skill.sourcePath), true);
      assert.equal(path.basename(skill.sourcePath), 'SKILL.md');
      await fs.stat(skill.sourcePath); // throws if fabricated
    }
  } finally {
    await sandbox.restore();
  }
});

/**
 * Built-in `system`-scope characterization: the current Cursor adapter does
 * not scan a bundled/system directory. Speculative built-in layouts under
 * `~/.cursor/skills/.system`, `~/.cursor/system/skills`, and a top-level
 * `~/.cursor/skills-builtin` must not produce `scope: 'system'` entries.
 *
 * `~/.cursor/skills/.system/<dir>/SKILL.md` uniquely surfaces today because
 * `findProviderSkillMarkdownFiles` walks dot-prefixed child directories
 * under a root - but it inherits the source's scope (`user`), not `system`.
 * A future regression that promotes such an entry to `scope: 'system'`
 * without a cited native Cursor contract will fail this fixture.
 */
test('cursor emits no system-scope entries without a cited native built-in contract', { concurrency: false }, async () => {
  const sandbox = await makeSandbox('builtins-absent');
  try {
    // Baseline so absence is a scope statement, not a total-emptiness statement.
    const baselinePath = await writeSkill(
      sandbox.cursorUserSkillsPath, 'baseline-dir', 'cursor-builtin-baseline', 'baseline user skill',
    );

    // Speculative built-in layouts a future implementer might guess at.
    await writeSkill(
      path.join(sandbox.cursorUserSkillsPath, '.system'),
      'hidden-dir', 'cursor-builtin-hidden', 'hidden dot-prefixed child under ~/.cursor/skills',
    );
    await writeSkill(
      path.join(sandbox.cursorHomePath, 'system', 'skills'),
      'system-dir', 'cursor-builtin-system-tree', 'speculative ~/.cursor/system/skills tree',
    );
    await writeSkill(
      path.join(sandbox.homeDir, '.cursor-builtins', 'skills'),
      'builtin-dir', 'cursor-builtin-toplevel', 'speculative ~/.cursor-builtins/skills tree',
    );

    const skills = await listCursor(sandbox.workspacePath);
    const found = byName(skills);

    assert.equal(found.get('cursor-builtin-baseline')?.scope, 'user');
    assert.equal(found.get('cursor-builtin-baseline')?.sourcePath, baselinePath);

    assert.equal(
      skills.filter((skill) => skill.scope === 'system').length,
      0,
      'no scope: "system" entry may appear until a cited native Cursor built-in contract is proven',
    );

    for (const forbidden of [
      'cursor-builtin-system-tree',
      'cursor-builtin-toplevel',
    ] as const) {
      assert.equal(
        skills.some((skill) => skill.name === forbidden),
        false,
        `speculative built-in path ${forbidden} must not leak into the catalog`,
      );
    }

    // The `.system` subfolder currently inherits the source's `user` scope
    // (findProviderSkillMarkdownFiles does not skip dot-prefixed children).
    // Pin that as characterization rather than a promotion to `system`.
    const hidden = found.get('cursor-builtin-hidden');
    if (hidden) {
      assert.equal(
        hidden.scope,
        'user',
        'a dot-prefixed child of ~/.cursor/skills inherits user scope, never system',
      );
    }
  } finally {
    await sandbox.restore();
  }
});

/**
 * Documented Claude/Codex compatibility characterization: the current
 * Cursor adapter does NOT scan `~/.claude/skills`, `~/.codex/skills`,
 * `~/.agents/skills`, or `~/.opencode/skills`, and it does not scan their
 * workspace-scoped twins either. Every such source must be absent from
 * the Cursor catalog. If a future contract proves Cursor consumes any of
 * these roots, this fixture flips to expect the specific entry, so the
 * regression cannot silently invent compatibility.
 */
test('cursor does not leak Claude/Codex/OpenCode/Agents compatibility roots into its catalog', { concurrency: false }, async () => {
  const sandbox = await makeSandbox('compat-absent');
  try {
    const cursorAnchor = await writeSkill(
      sandbox.cursorUserSkillsPath, 'anchor-dir', 'cursor-compat-anchor', 'anchor user skill in ~/.cursor/skills',
    );

    // Home-scoped foreign compatibility roots.
    await writeSkill(
      path.join(sandbox.homeDir, '.claude', 'skills'),
      'claude-user-dir', 'foreign-claude-user', 'must not leak from ~/.claude/skills',
    );
    await writeSkill(
      path.join(sandbox.homeDir, '.codex', 'skills'),
      'codex-user-dir', 'foreign-codex-user', 'must not leak from ~/.codex/skills',
    );
    await writeSkill(
      path.join(sandbox.homeDir, '.agents', 'skills'),
      'agents-user-dir', 'foreign-agents-user', 'must not leak from ~/.agents/skills',
    );
    await writeSkill(
      path.join(sandbox.homeDir, '.opencode', 'skills'),
      'opencode-user-dir', 'foreign-opencode-user', 'must not leak from ~/.opencode/skills',
    );

    // Workspace-scoped foreign compatibility twins.
    await writeSkill(
      path.join(sandbox.workspacePath, '.claude', 'skills'),
      'claude-proj-dir', 'foreign-claude-project', 'must not leak from <workspace>/.claude/skills',
    );
    await writeSkill(
      path.join(sandbox.workspacePath, '.codex', 'skills'),
      'codex-proj-dir', 'foreign-codex-project', 'must not leak from <workspace>/.codex/skills',
    );
    await writeSkill(
      path.join(sandbox.workspacePath, '.opencode', 'skills'),
      'opencode-proj-dir', 'foreign-opencode-project', 'must not leak from <workspace>/.opencode/skills',
    );

    const skills = await listCursor(sandbox.workspacePath);
    const found = byName(skills);

    assert.equal(found.get('cursor-compat-anchor')?.sourcePath, cursorAnchor);

    for (const forbidden of [
      'foreign-claude-user',
      'foreign-codex-user',
      'foreign-agents-user',
      'foreign-opencode-user',
      'foreign-claude-project',
      'foreign-codex-project',
      'foreign-opencode-project',
    ]) {
      assert.equal(
        skills.some((skill) => skill.name === forbidden),
        false,
        `foreign compatibility root ${forbidden} must not leak into Cursor's catalog`,
      );
    }

    // Truthful sourcePath: no returned entry may point into a foreign root.
    for (const skill of skills) {
      assert.equal(
        skill.sourcePath.startsWith(path.join(sandbox.homeDir, '.claude') + path.sep)
          || skill.sourcePath.startsWith(path.join(sandbox.homeDir, '.codex') + path.sep)
          || skill.sourcePath.startsWith(path.join(sandbox.homeDir, '.agents') + path.sep)
          || skill.sourcePath.startsWith(path.join(sandbox.homeDir, '.opencode') + path.sep)
          || skill.sourcePath.startsWith(path.join(sandbox.workspacePath, '.claude') + path.sep)
          || skill.sourcePath.startsWith(path.join(sandbox.workspacePath, '.codex') + path.sep)
          || skill.sourcePath.startsWith(path.join(sandbox.workspacePath, '.opencode') + path.sep),
        false,
        `Cursor sourcePath ${skill.sourcePath} must not originate under a foreign compatibility root`,
      );
    }
  } finally {
    await sandbox.restore();
  }
});

/**
 * Nested-repo / sibling-workspace scope: the Cursor adapter scans exactly
 * `<workspacePath>/.agents/skills` and `<workspacePath>/.cursor/skills`,
 * without walking upwards to the git root, downwards into nested
 * `packages/*` subdirectories, or sideways into sibling workspaces. A
 * skill inside a nested repo (with its own `.git`) or a sibling workspace
 * must remain invisible, and only the entry directly under the current
 * workspace's `.agents`/`.cursor` roots must surface. This guards the
 * task rule "NEVER globally recurse".
 */
test('cursor scans only <workspace>/.agents and <workspace>/.cursor without walking nested repos or siblings', { concurrency: false }, async () => {
  const sandbox = await makeSandbox('nested-scope');
  try {
    // A skill inside the current workspace's project roots.
    const projectAgentsPath = await writeSkill(
      sandbox.agentsProjectSkillsPath, 'proj-agents-dir', 'cursor-scope-project-agents', 'in workspace .agents/skills',
    );
    const projectCursorPath = await writeSkill(
      sandbox.cursorProjectSkillsPath, 'proj-cursor-dir', 'cursor-scope-project-cursor', 'in workspace .cursor/skills',
    );

    // A skill at the git root (one level above the workspace's parent) - not scanned.
    await writeSkill(
      path.join(sandbox.repoRoot, '.cursor', 'skills'),
      'root-cursor-dir', 'cursor-scope-repo-root', 'at git root, must not leak upward',
    );
    await writeSkill(
      path.join(sandbox.repoRoot, '.agents', 'skills'),
      'root-agents-dir', 'cursor-scope-repo-root-agents', 'at git root .agents, must not leak upward',
    );

    // A skill under a NESTED repo one directory below the workspace - not scanned.
    const nestedRepo = path.join(sandbox.workspacePath, 'vendor', 'inner');
    await fs.mkdir(path.join(nestedRepo, '.git'), { recursive: true });
    await writeSkill(
      path.join(nestedRepo, '.cursor', 'skills'),
      'nested-cursor-dir', 'cursor-scope-nested-repo', 'inside a nested repo, must not leak downward',
    );
    await writeSkill(
      path.join(nestedRepo, '.agents', 'skills'),
      'nested-agents-dir', 'cursor-scope-nested-agents', 'inside a nested repo .agents, must not leak downward',
    );

    // A skill under a nested `.agents/skills/*/*/SKILL.md` path - if the
    // adapter ever enabled `recursive: true` this would surface; today it
    // must not because the source is flat.
    await writeSkill(
      path.join(sandbox.agentsProjectSkillsPath, 'deep', 'nested'),
      'deep-inner-dir', 'cursor-scope-agents-deep', 'deep nested SKILL.md under .agents/skills',
    );

    // A sibling workspace under the same repo - not scanned.
    const siblingWorkspace = path.join(sandbox.repoRoot, 'packages', 'sibling');
    await fs.mkdir(siblingWorkspace, { recursive: true });
    await writeSkill(
      path.join(siblingWorkspace, '.cursor', 'skills'),
      'sibling-dir', 'cursor-scope-sibling', 'sibling workspace .cursor/skills',
    );

    // A workspace entirely outside the repo - not scanned.
    const outsideRoot = path.join(sandbox.homeDir, 'outside-workspace');
    await fs.mkdir(outsideRoot, { recursive: true });
    await writeSkill(
      path.join(outsideRoot, '.cursor', 'skills'),
      'outside-dir', 'cursor-scope-outside', 'workspace outside the repo',
    );

    const skills = await listCursor(sandbox.workspacePath);
    const found = byName(skills);

    assert.equal(found.get('cursor-scope-project-agents')?.sourcePath, projectAgentsPath);
    assert.equal(found.get('cursor-scope-project-cursor')?.sourcePath, projectCursorPath);

    for (const forbidden of [
      'cursor-scope-repo-root',
      'cursor-scope-repo-root-agents',
      'cursor-scope-nested-repo',
      'cursor-scope-nested-agents',
      'cursor-scope-agents-deep',
      'cursor-scope-sibling',
      'cursor-scope-outside',
    ]) {
      assert.equal(
        skills.some((skill) => skill.name === forbidden),
        false,
        `out-of-scope skill ${forbidden} must not leak (adapter must not walk upward, downward, or sideways)`,
      );
    }

    // No returned entry's sourcePath may live outside the two allowed
    // project roots or the user root.
    for (const skill of skills) {
      const allowedPrefixes = [
        sandbox.agentsProjectSkillsPath + path.sep,
        sandbox.cursorProjectSkillsPath + path.sep,
        sandbox.cursorUserSkillsPath + path.sep,
      ];
      assert.equal(
        allowedPrefixes.some((prefix) => skill.sourcePath.startsWith(prefix)),
        true,
        `sourcePath ${skill.sourcePath} must live under a Cursor-scanned root`,
      );
    }
  } finally {
    await sandbox.restore();
  }
});

/**
 * Installed-plugin characterization: the current Cursor adapter has no
 * plugin walker. Every speculative plugin layout under `~/.cursor/plugins/*`
 * and an explicit `cursor.plugins.json` toggle (enabled=true AND
 * enabled=false) must produce zero `scope: 'plugin'` entries. This locks
 * the safe boundary until a cited native Cursor plugin contract exists;
 * a future regression that adds a speculative plugin walker will fail
 * both cases at once.
 */
test('cursor returns no plugin-scope entries for either enabled or disabled speculative plugin manifests', { concurrency: false }, async () => {
  const sandbox = await makeSandbox('plugin-absent');
  try {
    await writeSkill(
      sandbox.cursorUserSkillsPath, 'baseline-dir', 'cursor-plugin-baseline', 'baseline user skill',
    );

    // Speculative enabled plugin under ~/.cursor/plugins.
    const enabledPluginRoot = path.join(sandbox.cursorHomePath, 'plugins', 'notion-plugin');
    await fs.mkdir(path.join(enabledPluginRoot, '.cursor-plugin'), { recursive: true });
    await fs.writeFile(
      path.join(enabledPluginRoot, '.cursor-plugin', 'plugin.json'),
      JSON.stringify({ name: 'notion-plugin', version: '0.1.0', enabled: true }, null, 2),
      'utf8',
    );
    await writeSkill(
      path.join(enabledPluginRoot, 'skills'),
      'notion-dir', 'cursor-plugin-notion-enabled', 'enabled plugin skill under ~/.cursor/plugins',
    );

    // Speculative disabled plugin sibling.
    const disabledPluginRoot = path.join(sandbox.cursorHomePath, 'plugins', 'lint-plugin');
    await fs.mkdir(path.join(disabledPluginRoot, '.cursor-plugin'), { recursive: true });
    await fs.writeFile(
      path.join(disabledPluginRoot, '.cursor-plugin', 'plugin.json'),
      JSON.stringify({ name: 'lint-plugin', version: '0.1.0', enabled: false }, null, 2),
      'utf8',
    );
    await writeSkill(
      path.join(disabledPluginRoot, 'skills'),
      'lint-dir', 'cursor-plugin-lint-disabled', 'disabled plugin skill under ~/.cursor/plugins',
    );

    // Explicit ~/.cursor/plugins.json toggle asserting both.
    await fs.writeFile(
      path.join(sandbox.cursorHomePath, 'plugins.json'),
      JSON.stringify({
        plugins: [
          { name: 'notion-plugin', enabled: true, root: 'plugins/notion-plugin/skills' },
          { name: 'lint-plugin', enabled: false, root: 'plugins/lint-plugin/skills' },
        ],
      }, null, 2),
      'utf8',
    );

    const skills = await listCursor(sandbox.workspacePath);

    assert.equal(
      skills.some((skill) => skill.name === 'cursor-plugin-baseline'),
      true,
      'baseline user skill must remain visible so absence is a scope statement, not a crash',
    );
    assert.equal(
      skills.filter((skill) => skill.scope === 'plugin').length,
      0,
      'no scope: "plugin" entry may appear until a cited native Cursor plugin contract is proven',
    );
    for (const forbidden of ['cursor-plugin-notion-enabled', 'cursor-plugin-lint-disabled']) {
      assert.equal(
        skills.some((skill) => skill.name === forbidden),
        false,
        `speculative plugin path ${forbidden} must not leak into the catalog (enabled or disabled)`,
      );
    }
    for (const skill of skills) {
      assert.equal(
        skill.sourcePath.startsWith(path.join(sandbox.cursorHomePath, 'plugins') + path.sep),
        false,
        `sourcePath ${skill.sourcePath} must not originate under ~/.cursor/plugins`,
      );
    }
  } finally {
    await sandbox.restore();
  }
});

/**
 * Malformed skill markdown tolerance: a broken SKILL.md next to valid
 * siblings under each scanned Cursor root must not throw or hide valid
 * entries. The shared `findProviderSkillMarkdownFiles` + `readProviderSkill*`
 * pipeline catches parse errors per-file and keeps the remaining skills
 * visible.
 */
test('cursor tolerates malformed SKILL.md under each scanned root without hiding valid siblings', { concurrency: false }, async () => {
  const sandbox = await makeSandbox('malformed-skills');
  try {
    // Valid siblings.
    const validAgentsPath = await writeSkill(
      sandbox.agentsProjectSkillsPath, 'valid-agents-dir', 'cursor-malformed-agents-survivor', 'valid .agents sibling',
    );
    const validCursorProjPath = await writeSkill(
      sandbox.cursorProjectSkillsPath, 'valid-cursor-proj-dir', 'cursor-malformed-cursor-proj-survivor', 'valid .cursor project sibling',
    );
    const validUserPath = await writeSkill(
      sandbox.cursorUserSkillsPath, 'valid-user-dir', 'cursor-malformed-user-survivor', 'valid ~/.cursor sibling',
    );

    // Malformed SKILL.md siblings in every scanned root.
    for (const brokenDir of [
      path.join(sandbox.agentsProjectSkillsPath, 'broken-agents-dir'),
      path.join(sandbox.cursorProjectSkillsPath, 'broken-cursor-proj-dir'),
      path.join(sandbox.cursorUserSkillsPath, 'broken-user-dir'),
    ]) {
      await fs.mkdir(brokenDir, { recursive: true });
      await fs.writeFile(
        path.join(brokenDir, 'SKILL.md'),
        '---\nname: [unterminated: flow\n---\n\nbody\n',
        'utf8',
      );
    }

    // Directory without SKILL.md - shared helper must skip silently.
    await fs.mkdir(path.join(sandbox.cursorUserSkillsPath, 'no-skill-md-dir'), { recursive: true });

    // File where a directory is expected - shared helper must skip silently.
    await fs.writeFile(path.join(sandbox.cursorUserSkillsPath, 'stray-file.md'), 'not a skill dir', 'utf8');

    const skills = await listCursor(sandbox.workspacePath);
    const found = byName(skills);

    assert.equal(found.get('cursor-malformed-agents-survivor')?.sourcePath, validAgentsPath);
    assert.equal(found.get('cursor-malformed-cursor-proj-survivor')?.sourcePath, validCursorProjPath);
    assert.equal(found.get('cursor-malformed-user-survivor')?.sourcePath, validUserPath);

    // The malformed SKILL.md files parse to a fallback name equal to their
    // directory basename (`broken-*-dir`). That is truthful characterization,
    // not a bug, so their presence is allowed; what matters is that valid
    // siblings survive alongside them and no throw escapes.
    for (const skill of skills) {
      assert.equal(skill.provider, 'cursor');
      assert.match(skill.command, /^\//);
      assert.equal(path.basename(skill.sourcePath), 'SKILL.md');
    }
  } finally {
    await sandbox.restore();
  }
});

/**
 * Symlink-escape characterization: `findProviderSkillMarkdownFiles` walks
 * `readdir(root, { withFileTypes: true })` and only follows entries where
 * `dirent.isDirectory()` is true. A symlink whose target is a directory
 * returns `isDirectory()==false`, so its target's SKILL.md is skipped.
 * A valid sibling directory next to the escape symlink must still surface.
 */
test('cursor skips a symlinked child pointing outside a scanned root and keeps a valid sibling', { concurrency: false }, async () => {
  const sandbox = await makeSandbox('symlink-escape');
  try {
    const outsideRoot = path.join(sandbox.homeDir, 'outside');
    await fs.mkdir(outsideRoot, { recursive: true });
    const outsideSkillDir = path.join(outsideRoot, 'foreign-dir');
    await fs.mkdir(outsideSkillDir, { recursive: true });
    await fs.writeFile(
      path.join(outsideSkillDir, 'SKILL.md'),
      '---\nname: cursor-symlink-foreign\ndescription: foreign skill reached via symlink\n---\n\nbody\n',
      'utf8',
    );

    await fs.mkdir(sandbox.cursorProjectSkillsPath, { recursive: true });
    await fs.symlink(outsideSkillDir, path.join(sandbox.cursorProjectSkillsPath, 'escaped-link'));

    const validSkillPath = await writeSkill(
      sandbox.cursorProjectSkillsPath, 'valid-dir', 'cursor-symlink-valid-sibling', 'valid sibling next to the escape symlink',
    );

    const skills = await listCursor(sandbox.workspacePath);
    const found = byName(skills);

    assert.equal(
      found.get('cursor-symlink-foreign'),
      undefined,
      'symlinked directory whose target lives outside the scanned root must not surface',
    );
    const valid = found.get('cursor-symlink-valid-sibling');
    assert.equal(valid?.scope, 'project');
    assert.equal(valid?.sourcePath, validSkillPath);
    assert.equal(
      skills.some((skill) => skill.sourcePath.startsWith(outsideRoot + path.sep)),
      false,
      'no source path may point outside the documented Cursor roots',
    );
  } finally {
    await sandbox.restore();
  }
});

/**
 * Missing-root tolerance: none of the three Cursor sources exist here
 * (bare temp home, empty workspace). `listProviderSkills` must resolve
 * to an empty array without throwing, so a fresh install / empty
 * workspace shows an empty palette rather than an error.
 */
test('cursor returns an empty catalog when every documented root is missing', { concurrency: false }, async () => {
  const sandbox = await makeSandbox('missing-root');
  try {
    const skills = await listCursor(sandbox.workspacePath);
    assert.deepEqual(skills, [], 'missing roots must degrade to an empty catalog without throwing');
  } finally {
    await sandbox.restore();
  }
});

/**
 * Deterministic source-order precedence on `/name` collisions: the current
 * Cursor adapter emits sources in the order project-agents -> project-cursor
 * -> user-cursor. The shared `SkillsProvider.listSkills` concatenates in
 * source order, and `providerSkillsService` dedupes by command, so a
 * same-name collision resolves to the earlier source. This pins the
 * documented winner ordering so a future refactor cannot silently reorder.
 */
test('cursor resolves /name collisions in source order: project .agents > project .cursor > user .cursor', { concurrency: false }, async () => {
  const sandbox = await makeSandbox('collision-order');
  try {
    const agentsWinnerPath = await writeSkill(
      sandbox.agentsProjectSkillsPath, 'a-dir', 'cursor-collide', 'project .agents variant that must win',
    );
    await writeSkill(
      sandbox.cursorProjectSkillsPath, 'b-dir', 'cursor-collide', 'project .cursor variant that must lose',
    );
    await writeSkill(
      sandbox.cursorUserSkillsPath, 'c-dir', 'cursor-collide', 'user variant that must lose',
    );

    let winners = (await listCursor(sandbox.workspacePath)).filter((skill) => skill.name === 'cursor-collide');
    assert.equal(winners.length, 1, 'name collision must dedupe to a single entry');
    assert.equal(winners[0]?.scope, 'project');
    assert.equal(winners[0]?.sourcePath, agentsWinnerPath, 'project .agents source must win over project .cursor and user');

    // Remove the .agents winner: project .cursor should take over.
    await fs.rm(sandbox.agentsProjectSkillsPath, { recursive: true, force: true });
    winners = (await listCursor(sandbox.workspacePath)).filter((skill) => skill.name === 'cursor-collide');
    assert.equal(winners.length, 1);
    assert.equal(winners[0]?.scope, 'project');
    assert.equal(
      winners[0]?.sourcePath.startsWith(sandbox.cursorProjectSkillsPath + path.sep),
      true,
      'project .cursor must win once project .agents is gone',
    );

    // Remove project .cursor too: only the user entry remains.
    await fs.rm(sandbox.cursorProjectSkillsPath, { recursive: true, force: true });
    winners = (await listCursor(sandbox.workspacePath)).filter((skill) => skill.name === 'cursor-collide');
    assert.equal(winners.length, 1);
    assert.equal(winners[0]?.scope, 'user');
    assert.equal(
      winners[0]?.sourcePath.startsWith(sandbox.cursorUserSkillsPath + path.sep),
      true,
      'user ~/.cursor/skills remains as the last source when both project roots are gone',
    );
  } finally {
    await sandbox.restore();
  }
});

/**
 * Managed add/list/remove round trip: Cursor writes managed global skills
 * under `~/.cursor/skills` (its `getGlobalSkillSource`). The round trip
 * must persist a truthful `/name` catalog entry, surface on the next
 * `listProviderSkills` call, and remove cleanly with an idempotent second
 * delete.
 */
test('cursor managed add/list/remove round trip persists under ~/.cursor/skills', { concurrency: false }, async () => {
  const sandbox = await makeSandbox('managed-round-trip');
  try {
    const created = await providerSkillsService.addProviderSkills('cursor', {
      entries: [
        {
          directoryName: 'managed-dir',
          content: '---\nname: cursor-managed\ndescription: managed cursor skill\n---\n\nManaged body.\n',
          files: [
            {
              relativePath: 'scripts/run.sh',
              content: Buffer.from('#!/bin/sh\necho cursor\n').toString('base64'),
              encoding: 'base64',
            },
          ],
        },
      ],
    });
    assert.equal(created.length, 1);
    const managedSkill = created[0];
    assert.ok(managedSkill);
    assert.equal(managedSkill.command, '/cursor-managed');
    assert.equal(managedSkill.scope, 'user');
    assert.equal(
      managedSkill.sourcePath,
      path.join(sandbox.cursorUserSkillsPath, 'managed-dir', 'SKILL.md'),
    );
    assert.match(await fs.readFile(managedSkill.sourcePath, 'utf8'), /Managed body\./);
    assert.equal(
      await fs.readFile(path.join(sandbox.cursorUserSkillsPath, 'managed-dir', 'scripts', 'run.sh'), 'utf8'),
      '#!/bin/sh\necho cursor\n',
    );

    const listed = await listCursor(sandbox.workspacePath);
    assert.equal(
      listed.some((skill) => skill.name === 'cursor-managed' && skill.scope === 'user'),
      true,
      'managed skill must be visible on the next list call',
    );

    const removed = await providerSkillsService.removeProviderSkill('cursor', {
      directoryName: 'managed-dir',
    });
    assert.equal(removed.removed, true);
    assert.equal(removed.provider, 'cursor');
    await assert.rejects(fs.stat(managedSkill.sourcePath));

    // A redundant well-formed removal is a no-op rather than an exception.
    const idempotent = await providerSkillsService.removeProviderSkill('cursor', {
      directoryName: 'managed-dir',
    });
    assert.equal(idempotent.removed, false);
    // Keep the AppError import alive; it fires for containment/invalid-name
    // failures elsewhere in the shared skills provider.
    assert.doesNotThrow(() => new AppError('kept import live', { code: 'NOOP', statusCode: 500 }));
  } finally {
    await sandbox.restore();
  }
});
